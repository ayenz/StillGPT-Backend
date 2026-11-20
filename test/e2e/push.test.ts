import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import webpush from 'web-push';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pushSubscriptions } from '../../src/db/schema.js';
import { jobPushMessage, type MediaJobView } from '../../src/core/media.js';
import { isPushEndpoint, PushService, type PushTarget } from '../../src/core/push.js';
import { silentLogger } from '../../src/log.js';
import { makePng } from '../mock-qoder/index.js';
import { type Harness, startHarness } from './harness.js';
import { readSse } from './native-sse.js';

const KEY = 'up-key';
const FCM = 'https://fcm.googleapis.com/fcm/send/device-1';
const SUB = { endpoint: FCM, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } };

/** Fake upscale sidecar (CPU only): 200 with a JPEG, or the next scripted failure. */
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

interface Sent {
  target: PushTarget;
  msg: { title: string; body: string; url: string; tag: string; image?: string };
}

let h: Harness;
let up: Awaited<ReturnType<typeof startFakeUpscaler>>;
const sent: Sent[] = [];
let failWith: number | null = null;
const vapid = webpush.generateVAPIDKeys();

beforeAll(async () => {
  up = await startFakeUpscaler();
  h = await startHarness({
    env: { MEDIA_POLL_INTERVAL_MS: '50', FACESWAP_URL: up.url, FACESWAP_API_KEY: KEY, VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey },
    pushSender: async (target, payload) => {
      if (failWith) throw Object.assign(new Error('push service error'), { statusCode: failWith });
      sent.push({ target, msg: JSON.parse(payload) });
    },
  });
});
afterAll(async () => {
  await h?.close();
  await up?.close();
});
beforeEach(async () => {
  sent.length = 0;
  failWith = null;
  await h.ctx.database.db.delete(pushSubscriptions);
});

const json = async (res: Response) => ({ status: res.status, body: (await res.json().catch(() => null)) as any });
const subscribe = (body: unknown = SUB) => h.api('/api/v1/me/push-subscriptions', { method: 'POST', json: body });
const subs = () => h.ctx.database.db.select().from(pushSubscriptions);

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

describe('push subscriptions', () => {
  it('GET /me/push reports the VAPID key (FCM off without a service account)', async () => {
    expect((await json(await h.api('/api/v1/me/push'))).body).toEqual({ enabled: true, public_key: vapid.publicKey, fcm: false });
  });

  it('stores one row per endpoint and rejects non push-service endpoints', async () => {
    expect((await subscribe()).status).toBe(201);
    expect((await subscribe()).status).toBe(201);
    expect(await subs()).toHaveLength(1);
    for (const endpoint of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://evil.example/fcm.googleapis.com', 'https://fcm.googleapis.com.evil.example/x']) {
      const r = await json(await subscribe({ ...SUB, endpoint }));
      expect(r.status, endpoint).toBe(400);
    }
    expect((await json(await subscribe({ ...SUB, keys: { p256dh: 'not base64!', auth: 'x' } }))).status).toBe(400);
  });

  it('DELETE removes this browser; test sends to it; unknown endpoint is 404', async () => {
    await subscribe();
    expect((await h.api('/api/v1/me/push-subscriptions/test', { method: 'POST', json: { endpoint: FCM } })).status).toBe(204);
    expect(sent[0]!.msg).toMatchObject({ title: 'Notifications are on', url: '/gallery', tag: 'test' });
    expect(sent[0]!.target).toEqual(SUB);
    expect((await h.api('/api/v1/me/push-subscriptions', { method: 'DELETE', json: { endpoint: FCM } })).status).toBe(204);
    expect(await subs()).toHaveLength(0);
    expect((await h.api('/api/v1/me/push-subscriptions/test', { method: 'POST', json: { endpoint: FCM } })).status).toBe(404);
  });

  it('a disabled server answers 503 and notifies nobody', async () => {
    const off = new PushService({ db: h.ctx.database.db, log: silentLogger, config: null });
    expect(off.enabled).toBe(false);
    await expect(off.subscribe(h.userId, SUB)).rejects.toMatchObject({ status: 503, code: 'push_unavailable' });
    await off.notify(h.userId, { title: 't', body: 'b', url: '/', tag: 't' });
  });
});

describe('notifications when a job finishes', () => {
  it('upscale done: title, gallery link, preview picture, no prompt', async () => {
    await subscribe();
    const id = await upscaleJob({ scale: 4 });
    await waitFor(() => sent.length === 1);
    const { msg } = sent[0]!;
    expect(msg).toMatchObject({ title: 'Upscale 4x ready', body: 'Tap to open it in your gallery.', url: `/gallery/${id}`, tag: `job-${id}` });
    expect(msg.image).toContain('variant=preview');
    expect(JSON.stringify(msg)).not.toContain('Upscale 4x (Natural)'); // the job's prompt
    expect((await subs())[0]!.lastSuccessAt).not.toBeNull();
  });

  it('a failed job says why', async () => {
    await subscribe();
    up.failNext(422, 'BAD_IMAGE');
    const id = await upscaleJob({ scale: 2 });
    await waitFor(() => sent.length === 1);
    expect(sent[0]!.msg).toEqual({ title: 'Upscale 2x failed', body: 'The image could not be read', url: `/gallery/${id}`, tag: `job-${id}` });
  });

  it('jobs with a callback_url (automation) do not notify', async () => {
    await subscribe();
    await upscaleJob({ callback_url: 'http://127.0.0.1:9/hook' });
    await new Promise((r) => setTimeout(r, 200));
    expect(sent).toHaveLength(0);
  });

  it('a subscription the push service reports gone is deleted', async () => {
    await subscribe();
    failWith = 410;
    await upscaleJob();
    await waitFor(async () => (await subs()).length === 0);
  });

  it('other errors keep the subscription', async () => {
    await subscribe();
    failWith = 500;
    await upscaleJob();
    await new Promise((r) => setTimeout(r, 200));
    expect(await subs()).toHaveLength(1);
  });
});

describe('jobPushMessage', () => {
  const view = (o: Partial<MediaJobView> = {}): MediaJobView => ({
    id: 'job_1',
    kind: 'image',
    status: 'completed',
    progress: 100,
    request: { prompt: 'a secret prompt' },
    outputs: [{ id: 'file_1', name: 'a.png', mimeType: 'image/png', size: 1, kind: 'image', url: 'https://x/media/1', thumbnailUrl: 'https://x/t', previewUrl: 'https://x/p' }],
    error: null,
    credits: 1,
    batch_id: null,
    created_at: '',
    completed_at: '',
    ...o,
  });

  it('names each kind of job', () => {
    expect(jobPushMessage(view()).title).toBe('Image ready');
    expect(jobPushMessage(view({ kind: 'video' })).title).toBe('Video ready');
    expect(jobPushMessage(view({ request: { face_swap: {} } })).title).toBe('Face swap ready');
    expect(jobPushMessage(view({ request: { upscale: { scale: 4 } } })).title).toBe('Upscale 4x ready');
    expect(JSON.stringify(jobPushMessage(view()))).not.toContain('secret');
  });

  it('one message per batch: all done, some failed, all failed', () => {
    const b = { batch_id: 'bat_1' };
    expect(jobPushMessage(view(b), { n: 4, completed: 4, openId: 'job_1' })).toEqual({
      title: '4 images ready',
      body: 'Tap to open them in your gallery.',
      url: '/gallery/job_1',
      tag: 'job-bat_1',
      image: 'https://x/p',
    });
    const failedLast = view({ ...b, id: 'job_4', status: 'failed', outputs: [], error: { code: 'x', message: 'Upstream error' } });
    expect(jobPushMessage(failedLast, { n: 4, completed: 3, openId: 'job_1' })).toEqual({
      title: '3 of 4 images ready',
      body: '1 failed. Tap to open your gallery.',
      url: '/gallery/job_1',
      tag: 'job-bat_1',
    });
    expect(jobPushMessage(failedLast, { n: 4, completed: 0, openId: null })).toMatchObject({ title: 'Image failed', body: 'Upstream error' });
    expect(jobPushMessage(view({ ...b, request: { face_swap: {} } }), { n: 2, completed: 2, openId: 'job_1' }).title).toBe('2 face swap results ready');
  });

  it('only push service hosts are endpoints', () => {
    expect(isPushEndpoint('https://web.push.apple.com/QA')).toBe(true);
    expect(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(isPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x')).toBe(true);
    expect(isPushEndpoint('https://fcm.googleapis.com:8443/x')).toBe(false);
    expect(isPushEndpoint('https://user:pw@fcm.googleapis.com/x')).toBe(false);
  });
});

