import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fcmTokens } from '../../src/db/schema.js';
import { FcmService, isPublicHttpsUrl, parseServiceAccount } from '../../src/core/fcm.js';
import { jobFcmMessage, type MediaJobView } from '../../src/core/media.js';
import { silentLogger } from '../../src/log.js';
import { makePng } from '../mock-qoder/index.js';
import { type Harness, startHarness } from './harness.js';
import { readSse } from './native-sse.js';

const KEY = 'up-key';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ACCOUNT = {
  type: 'service_account',
  project_id: 'stillgpt-test',
  client_email: 'fcm@stillgpt-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};
const ACCOUNT_B64 = Buffer.from(JSON.stringify(ACCOUNT)).toString('base64');

/** Fake upscale sidecar (CPU only): 200 with an image, or the next scripted failure. */
async function startFakeUpscaler() {
  const failures: { status: number; detail: string }[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const reply = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (req.headers['x-api-key'] !== KEY) return reply(401, { detail: 'AUTH_INVALID' });
      if (req.url === '/health/ready') return reply(200, { ready: true, upscale: { ready: true, device: 'cpu' } });
      const f = failures.shift();
      if (f) return reply(f.status, { detail: f.detail });
      const b = JSON.parse(raw);
      return reply(200, { image: makePng(60, 80).toString('base64'), mime_type: 'image/jpeg', width: 60, height: 80, scale: b.scale, mode: b.mode, pipeline: 'P4', device: 'cpu', faces: 0, faces_enhanced: 0, eyes_fixed: 0 });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    failNext: (status: number, detail: string) => failures.push({ status, detail }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

interface FcmSent {
  token: string;
  notification: { title: string; body: string; image?: string };
  android: { priority: string; notification: { channel_id: string; icon: string; tag: string } };
  data: Record<string, string>;
}

/** Fake Google: the OAuth token endpoint (checks the JWT) and FCM messages:send (per-token scripted errors). */
function fakeGoogle() {
  const sent: FcmSent[] = [];
  const errors = new Map<string, { status: number; error: unknown }>();
  let oauthCalls = 0;
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      oauthCalls++;
      const form = new URLSearchParams(String(init!.body));
      expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      const [h, p, s] = form.get('assertion')!.split('.');
      expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s!, 'base64url'))).toBe(true);
      const claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
      expect(claims).toMatchObject({ iss: ACCOUNT.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token' });
      return reply(200, { access_token: 'ya29.test', expires_in: 3599, token_type: 'Bearer' });
    }
    if (url === `https://fcm.googleapis.com/v1/projects/${ACCOUNT.project_id}/messages:send`) {
      expect(new Headers(init!.headers).get('authorization')).toBe('Bearer ya29.test');
      const { message } = JSON.parse(String(init!.body)) as { message: FcmSent };
      const e = errors.get(message.token);
      if (e) return reply(e.status, { error: e.error });
      sent.push(message);
      return reply(200, { name: `projects/${ACCOUNT.project_id}/messages/1` });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return { sent, errors, fetchImpl, oauthCalls: () => oauthCalls };
}

const fcmError = (status: number, statusText: string, message: string, errorCode?: string) => ({
  status,
  error: {
    code: status,
    message,
    status: statusText,
    ...(errorCode ? { details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] } : {}),
  },
});

let h: Harness;
let up: Awaited<ReturnType<typeof startFakeUpscaler>>;
const google = fakeGoogle();

beforeAll(async () => {
  up = await startFakeUpscaler();
  h = await startHarness({
    env: { MEDIA_POLL_INTERVAL_MS: '50', FACESWAP_URL: up.url, FACESWAP_API_KEY: KEY, FCM_SERVICE_ACCOUNT_B64: ACCOUNT_B64 },
    fcmFetch: google.fetchImpl,
  });
});
afterAll(async () => {
  await h?.close();
  await up?.close();
});
beforeEach(async () => {
  google.sent.length = 0;
  google.errors.clear();
  await h.ctx.database.db.delete(fcmTokens);
});

const json = async (res: Response) => ({ status: res.status, body: (await res.json().catch(() => null)) as any });
const register = (body: unknown, key?: string) => h.api('/api/v1/me/fcm-tokens', { method: 'POST', json: body, key });
const tokens = () => h.ctx.database.db.select().from(fcmTokens);

async function upload() {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(makePng(30, 40))], { type: 'image/png' }), 'photo.png');
  return (await (await h.api('/api/v1/files', { method: 'POST', body: form })).json()) as { id: string };
}
async function upscaleJob(payload: Record<string, unknown> = {}) {
  const src = await upload();
  const r = await json(await h.api(`/api/v1/images/${src.id}/upscale`, { method: 'POST', json: payload }));
  expect(r.status).toBe(202);
  await readSse(await h.api(`/api/v1/jobs/${r.body.id}/events`));
  return r.body.id as string;
}
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 250));

describe('FCM tokens', () => {
  it('GET /me/push reports fcm', async () => {
    expect((await json(await h.api('/api/v1/me/push'))).body).toMatchObject({ enabled: false, fcm: true });
  });

  it('registers, upserts by token, moves a token to the current user, validates', async () => {
    expect((await register({ token: 'tok-1', platform: 'android', device: 'Pixel 8' })).status).toBe(204);
    expect((await register({ token: 'tok-1', platform: 'android', device: 'Pixel 8 Pro' })).status).toBe(204);
    let rows = await tokens();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: h.userId, token: 'tok-1', platform: 'android', device: 'Pixel 8 Pro' });
    expect((await register({ token: 'tok-1', platform: 'android' }, h.admin.apiKey)).status).toBe(204);
    rows = await tokens();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).not.toBe(h.userId);
    for (const bad of [{ token: '', platform: 'android' }, { token: 'x', platform: 'ios' }, { token: 'x'.repeat(4097), platform: 'android' }, { token: 'x', platform: 'android', device: 'd'.repeat(101) }])
      expect((await register(bad)).status).toBe(400);
  });

  it('DELETE removes only the caller’s own token', async () => {
    await register({ token: 'tok-mine', platform: 'android' });
    await register({ token: 'tok-admin', platform: 'android' }, h.admin.apiKey);
    expect((await h.api('/api/v1/me/fcm-tokens', { method: 'DELETE', json: { token: 'tok-admin' } })).status).toBe(204);
    expect((await h.api('/api/v1/me/fcm-tokens', { method: 'DELETE', json: { token: 'tok-mine' } })).status).toBe(204);
    expect((await tokens()).map((t) => t.token)).toEqual(['tok-admin']);
  });

  it('test sends to every token of the caller', async () => {
    expect((await h.api('/api/v1/me/fcm-tokens/test', { method: 'POST' })).status).toBe(404);
    await register({ token: 'tok-a', platform: 'android' });
    await register({ token: 'tok-b', platform: 'android' });
    const r = await json(await h.api('/api/v1/me/fcm-tokens/test', { method: 'POST' }));
    expect(r).toEqual({ status: 202, body: { sent: 2, failed: 0 } });
    expect(google.sent.map((m) => m.token).sort()).toEqual(['tok-a', 'tok-b']);
    expect(google.sent[0]).toMatchObject({
      notification: { title: 'StillGPT notifications are on' },
      android: { priority: 'high', notification: { channel_id: 'creations', icon: 'ic_stat_stillgpt', tag: 'test' } },
      data: { type: 'test' },
    });
    expect(google.oauthCalls()).toBe(1); // access token cached
  });

  it('without a service account: tokens are stored, fcm false, test 503, notify sends nothing', async () => {
    const off = new FcmService({ db: h.ctx.database.db, log: silentLogger, account: null, fetchImpl: google.fetchImpl });
    expect(off.enabled).toBe(false);
    await off.register(h.userId, 'tok-off', 'android');
    expect(await tokens()).toHaveLength(1);
    await expect(off.test(h.userId)).rejects.toMatchObject({ status: 503, code: 'push_unavailable' });
    await off.notify(h.userId, { title: 't', body: 'b', tag: 't', data: { type: 'test' } });
    expect(google.sent).toHaveLength(0);
  });
});

describe('FCM when a job finishes', () => {
  it('one message per token with title, tag and data; no prompt; no non-public image', async () => {
    await register({ token: 'tok-a', platform: 'android' });
    await register({ token: 'tok-b', platform: 'android' });
    const id = await upscaleJob({ scale: 4 });
    await waitFor(() => google.sent.length === 2);
    for (const m of google.sent)
      expect(m).toEqual({
        token: m.token,
        notification: { title: 'Upscale 4x ready', body: 'Tap to open it in your gallery.' }, // http://127.0.0.1 preview is not fetchable by FCM
        android: { priority: 'high', ttl: '86400s', notification: { channel_id: 'creations', icon: 'ic_stat_stillgpt', tag: id } },
        data: { type: 'job', job_id: id, path: `/jobs/${id}` },
      });
    expect(JSON.stringify(google.sent)).not.toContain('Upscale 4x (Natural)');
  });

  it('a failed job says why', async () => {
    await register({ token: 'tok-a', platform: 'android' });
    up.failNext(422, 'BAD_IMAGE');
    const id = await upscaleJob({ scale: 2 });
    await waitFor(() => google.sent.length === 1);
    expect(google.sent[0]!.notification).toEqual({ title: 'Upscale 2x failed', body: 'The image could not be read' });
    expect(google.sent[0]!.data).toEqual({ type: 'job', job_id: id, path: `/jobs/${id}` });
  });

  it('a batch notifies once, when its last job is done', async () => {
    await register({ token: 'tok-a', platform: 'android' });
    const r = await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'kucing', n: 3 } }));
    expect(r.body).toMatchObject({ status: 'completed', n: 3 });
    await waitFor(() => google.sent.length === 1);
    await settle();
    expect(google.sent).toHaveLength(1);
    expect(google.sent[0]).toMatchObject({
      notification: { title: '3 images ready' },
      android: { notification: { tag: r.body.id } },
      data: { type: 'batch', batch_id: r.body.id, path: `/batches/${r.body.id}` },
    });
  });

  it('jobs with a callback_url do not notify', async () => {
    await register({ token: 'tok-a', platform: 'android' });
    await upscaleJob({ callback_url: 'http://127.0.0.1:9/hook' });
    await settle();
    expect(google.sent).toHaveLength(0);
  });

  it('unregistered / not found / invalid tokens are deleted; other errors keep the token', async () => {
    for (const t of ['tok-unreg', 'tok-404', 'tok-invalid', 'tok-payload', 'tok-500', 'tok-ok']) await register({ token: t, platform: 'android' });
    google.errors.set('tok-unreg', fcmError(404, 'NOT_FOUND', 'Requested entity was not found.', 'UNREGISTERED'));
    google.errors.set('tok-404', fcmError(404, 'NOT_FOUND', 'Requested entity was not found.'));
    google.errors.set('tok-invalid', fcmError(400, 'INVALID_ARGUMENT', 'The registration token is not a valid FCM registration token', 'INVALID_ARGUMENT'));
    google.errors.set('tok-payload', fcmError(400, 'INVALID_ARGUMENT', 'Invalid value at message.data', 'INVALID_ARGUMENT'));
    google.errors.set('tok-500', fcmError(503, 'UNAVAILABLE', 'try later', 'UNAVAILABLE'));
    await upscaleJob();
    await waitFor(async () => (await tokens()).length === 3);
    await settle();
    expect((await tokens()).map((t) => t.token).sort()).toEqual(['tok-500', 'tok-ok', 'tok-payload']);
    expect(google.sent.map((m) => m.token)).toEqual(['tok-ok']);
  });
});

describe('FCM message', () => {
  const view = (o: Partial<MediaJobView> = {}): MediaJobView => ({
    id: 'job_1',
    kind: 'image',
    status: 'completed',
    progress: 100,
    request: { prompt: 'a secret prompt' },
    outputs: [{ id: 'file_1', name: 'a.png', mimeType: 'image/png', size: 1, kind: 'image', url: 'https://x/media/1', thumbnailUrl: 'https://x/t', previewUrl: 'https://gpt.example.com/media/1?variant=preview' }],
    error: null,
    credits: 1,
    batch_id: null,
    created_at: '',
    completed_at: '',
    ...o,
  });

  it('job and batch payloads', () => {
    expect(jobFcmMessage(view())).toEqual({
      title: 'Image ready',
      body: 'Tap to open it in your gallery.',
      tag: 'job_1',
      image: 'https://gpt.example.com/media/1?variant=preview',
      data: { type: 'job', job_id: 'job_1', path: '/jobs/job_1' },
    });
    expect(jobFcmMessage(view({ batch_id: 'batch_1' }), { n: 2, completed: 2, openId: 'job_1' })).toMatchObject({
      title: '2 images ready',
      tag: 'batch_1',
      data: { type: 'batch', batch_id: 'batch_1', path: '/batches/batch_1' },
    });
    expect(JSON.stringify(jobFcmMessage(view()))).not.toContain('secret');
  });

  it('sends the picture only when FCM can fetch it', async () => {
    expect(isPublicHttpsUrl('https://gpt.example.com/media/1?variant=preview')).toBe(true);
    for (const u of ['http://gpt.example.com/m', 'https://localhost/m', 'https://127.0.0.1/m', 'https://[::1]/m', 'https://box/m', 'https://nas.local/m'])
      expect(isPublicHttpsUrl(u), u).toBe(false);
    const g = fakeGoogle();
    const svc = new FcmService({ db: h.ctx.database.db, log: silentLogger, account: parseServiceAccount(ACCOUNT_B64), fetchImpl: g.fetchImpl });
    await svc.register(h.userId, 'tok-img', 'android');
    await svc.notify(h.userId, jobFcmMessage(view()));
    expect(g.sent[0]!.notification.image).toBe('https://gpt.example.com/media/1?variant=preview');
  });

  it('rejects a malformed service account', () => {
    expect(() => parseServiceAccount('not json')).toThrow();
    expect(() => parseServiceAccount(Buffer.from(JSON.stringify({ project_id: 'p' })).toString('base64'))).toThrow(/client_email/);
  });
});
