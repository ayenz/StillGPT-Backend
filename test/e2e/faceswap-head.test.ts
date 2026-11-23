import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_FACE_SWAP_SETTINGS,
  DEFAULT_HEAD_SWAP_SETTINGS,
  fillHeadSwapTemplate,
  HEAD_SWAP_Q4_PROMPT,
  HEAD_SWAP_Q5_TEMPLATE,
  headSwapCost,
} from '../../src/core/faceSwap.js';
import { emptyCounts } from '../../src/core/trash.js';
import { conversations, faces, files, kv, mediaJobs, usageEvents } from '../../src/db/schema.js';
import { makePng } from '../mock-qoder/index.js';
import { type Harness, startHarness } from './harness.js';
import { readSse } from './native-sse.js';

const KEY = 'head-swap-key';
const TRAITS = { hair: 'jet black hair in a high bun', expression: 'wide open-mouth smile showing upper teeth', angle: 'frontal, head slightly tilted' };

interface Call {
  path: string;
  body: any;
}

/**
 * Fake faceswap sidecar with `/v1/head-composite`: every composite returns a distinct PNG (its call number in the
 * pixel colour) and the next scripted features (default: a fixed rotation, so candidates differ).
 */
async function startFakeSidecar() {
  const calls: Call[] = [];
  const failures: { path: string; status: number; detail: string }[] = [];
  let n = 0;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const reply = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (req.headers['x-api-key'] !== KEY) return reply(401, { detail: 'AUTH_INVALID' });
      if (req.method === 'GET' && req.url === '/health/ready') return reply(200, { ready: true, models: { swapper: 'inswapper_128' } });
      const path = req.url ?? '';
      calls.push({ path, body: raw ? JSON.parse(raw) : null });
      const i = failures.findIndex((f) => f.path === path);
      if (i >= 0) {
        const [f] = failures.splice(i, 1);
        return reply(f!.status, { detail: f!.detail });
      }
      if (path === '/v1/head-composite') {
        const k = n++;
        const features = { hair_dE: [12, 3, 30][k % 3]!, d_expr: [0.1, 0.05, 0.3][k % 3]!, identity: [0.6, 0.55, 0.7][k % 3]!, aligned: true, fallback: false, inliers: 80 };
        return reply(200, { image: makePng(7, 9, [k % 256, 1, 2]).toString('base64'), mime_type: 'image/png', width: 30, height: 40, features, timings_ms: { total: 5 } });
      }
      if (path === '/v1/swap')
        return reply(200, { image: makePng(5, 5, [1, 2, 3]).toString('base64'), mime_type: 'image/png', width: 5, height: 5, target_faces: 1, source_faces: 1, timings_ms: { swap: 12 } });
      reply(404, { detail: 'Not Found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    composites: () => calls.filter((c) => c.path === '/v1/head-composite'),
    failNext: (path: string, status: number, detail: string) => failures.push({ path, status, detail }),
    reset() {
      calls.length = 0;
      failures.length = 0;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

let h: Harness;
let sidecar: Awaited<ReturnType<typeof startFakeSidecar>>;
let describes = 0;
beforeAll(async () => {
  sidecar = await startFakeSidecar();
  h = await startHarness({ env: { MEDIA_POLL_INTERVAL_MS: '50', FACESWAP_URL: sidecar.url, FACESWAP_API_KEY: KEY } });
});
afterAll(async () => {
  await h?.close();
  await sidecar?.close();
});
const describeReply = (reply: string | undefined) =>
  h.qoder.setReply((text) => {
    if (!text.includes('hair: exact hair colour')) return undefined;
    describes++;
    return reply;
  });
beforeEach(async () => {
  sidecar.reset();
  describes = 0;
  describeReply(JSON.stringify(TRAITS));
  await h.ctx.faceswap!.readiness(true);
});
afterEach(() => {
  h.qoder.setReply(undefined);
  h.qoder.setToolError(undefined);
});

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });
const db = () => h.ctx.database.db;

async function upload(filename: string, bytes: Buffer, key?: string) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), filename);
  return (await (await h.api('/api/v1/files', { method: 'POST', body: form, key })).json()) as { id: string };
}

async function setup(opts: { portrait?: boolean; key?: string } = {}) {
  const targetBytes = makePng(30, 40, [5, 5, 5]);
  const faceBytes = makePng(4, 4, [9, 9, 9]);
  const portraitBytes = makePng(10, 20, [3, 3, 3]);
  const target = await upload('target.png', targetBytes, opts.key);
  const faceFile = await upload('face.png', faceBytes, opts.key);
  const portrait = opts.portrait ? await upload('portrait.png', portraitBytes, opts.key) : null;
  const face = (await json(await h.api('/api/v1/faces', { method: 'POST', json: { name: 'Andi', file_id: faceFile.id, ...(portrait ? { portrait_file_id: portrait.id } : {}) }, key: opts.key }))).body;
  return { target, faceFile, face, portrait, targetBytes, faceBytes, portraitBytes };
}

const swap = (fileId: string, payload: unknown, key?: string) => h.api(`/api/v1/images/${fileId}/face-swap`, { method: 'POST', json: payload, key });
const finished = async (batchId: string, key?: string) => {
  await readSse(await h.api(`/api/v1/images/batches/${batchId}/events`, { key }));
  return (await json(await h.api(`/api/v1/images/batches/${batchId}`, { key }))).body;
};
const download = async (url: string) => Buffer.from(await (await fetch(url)).arrayBuffer());
const usageTotal = async (jobId: string) =>
  (await db().select().from(usageEvents).where(eq(usageEvents.jobId, jobId))).reduce((sum, u) => sum + u.creditsTotal, 0);
/** Hidden Qoder conversations of a job's candidate turns. */
const candidateTurns = async (jobId: string) =>
  (await db().select().from(conversations).where(and(sql`${conversations.metadata}->>'job_id' = ${jobId}`, sql`${conversations.metadata} ? 'head_swap_candidate'`))).length;
const fileRow = async (id: string) => (await db().select().from(files).where(eq(files.id, id)))[0]!;
const resumeAll = () => (h.ctx.media as unknown as { resumeAll(): Promise<void> }).resumeAll();

describe('head swap helpers', () => {
  it('fills the template placeholders and falls back to neutral wording', () => {
    const filled = fillHeadSwapTemplate(HEAD_SWAP_Q5_TEMPLATE, TRAITS);
    expect(filled).toContain(`In image 1 she has ${TRAITS.hair}: keep exactly`);
    expect(filled).toContain(`Her expression in image 1 is: ${TRAITS.expression}.`);
    expect(filled).toContain(`head angle (${TRAITS.angle})`);
    expect(filled).not.toMatch(/\{(hair|expression|angle)\}/);
    expect(fillHeadSwapTemplate(HEAD_SWAP_Q5_TEMPLATE, null)).toContain('In image 1 she has the hair shown in image 1');
    expect(fillHeadSwapTemplate('{hair} {angle}', { hair: 'a {x}\nb', expression: '', angle: '' })).toBe('a x b as in image 1');
    expect(fillHeadSwapTemplate(HEAD_SWAP_Q4_PROMPT, TRAITS)).toBe(HEAD_SWAP_Q4_PROMPT);
  });

  it('cost: hair (capped at 40) / 10 + expression * 4 - identity * 2', () => {
    expect(headSwapCost({ hair_dE: 12, d_expr: 0.1, identity: 0.6 })).toBeCloseTo(1.2 + 0.4 - 1.2, 9);
    expect(headSwapCost({ hair_dE: 99, d_expr: 0, identity: 0 })).toBeCloseTo(4, 9);
  });

  it('defaults: head_swap is the default engine with Q5 portrait, Q5 combo, Q4 portrait', () => {
    expect(DEFAULT_FACE_SWAP_SETTINGS.default_engine).toBe('head_swap');
    expect(DEFAULT_HEAD_SWAP_SETTINGS.candidates).toEqual([
      { template: HEAD_SWAP_Q5_TEMPLATE, reference: 'portrait' },
      { template: HEAD_SWAP_Q5_TEMPLATE, reference: 'combo' },
      { template: HEAD_SWAP_Q4_PROMPT, reference: 'portrait' },
    ]);
    expect(DEFAULT_HEAD_SWAP_SETTINGS.swapper).toMatchObject({ restorer: 'gfpgan', restore_blend: 0.8 });
    expect(DEFAULT_HEAD_SWAP_SETTINGS.eye_keep).toBe(true);
  });
});

describe('head_swap engine', () => {
  it('default engine: describe once per target, K candidates per job, one composite each, the lowest cost wins', async () => {
    const { target, faceFile, face, targetBytes, faceBytes } = await setup();
    const r = await json(await swap(target.id, { face_id: face.id, n: 2 }));
    expect(r.status).toBe(202);
    expect(r.body.n).toBe(2);
    const req = r.body.jobs[0].request;
    expect(req).toMatchObject({
      size: '1024x1280',
      input_file_ids: [target.id, faceFile.id],
      face_swap: {
        engine: 'head_swap',
        source_file_id: target.id,
        face_file_id: faceFile.id,
        options: DEFAULT_HEAD_SWAP_SETTINGS.swapper,
        head_swap: { candidates: DEFAULT_HEAD_SWAP_SETTINGS.candidates, describe_prompt: DEFAULT_HEAD_SWAP_SETTINGS.describe_prompt, eye_keep: true },
      },
    });
    // no portrait: portrait and combo fall back to the main image
    expect(req.face_swap.candidates).toEqual([0, 1, 2].map((i) => ({ template_index: i, reference: DEFAULT_HEAD_SWAP_SETTINGS.candidates[i]!.reference, reference_used: 'primary', reference_file_id: faceFile.id })));
    expect(req.face_swap.all_candidates).toBeUndefined();

    const b = await finished(r.body.id);
    expect(b.status).toBe('completed');
    expect(describes).toBe(1);
    expect((await fileRow(target.id)).headTraits).toEqual(TRAITS);
    expect(sidecar.composites()).toHaveLength(6);
    for (const c of sidecar.composites()) {
      expect(Buffer.from(c.body.original, 'base64').equals(targetBytes)).toBe(true);
      expect(Buffer.from(c.body.generated, 'base64').equals(makePng())).toBe(true); // the mock Qoder's candidate
      expect(c.body.sources.map((s: string) => Buffer.from(s, 'base64').equals(faceBytes))).toEqual([true]);
      expect(c.body.options).toEqual({ swapper: DEFAULT_HEAD_SWAP_SETTINGS.swapper, eye_keep: true });
    }
    // only one job paid for the description
    expect(b.jobs.map((j: any) => j.request.face_swap.describe_credits > 0).sort()).toEqual([false, true]);

    for (const job of b.jobs) {
      const fs = job.request.face_swap;
      expect(fs.traits).toEqual(TRAITS);
      expect(fs.candidates).toHaveLength(3);
      for (const c of fs.candidates) {
        expect(c).toMatchObject({ file_id: expect.any(String), composite_file_id: expect.any(String), backend: 'cpu', job_qoder_session: expect.any(String) });
        expect(c.error).toBeUndefined();
        expect(c.credits).toBeGreaterThan(0);
        expect(c.cost).toBeCloseTo(headSwapCost(c.features), 3);
      }
      expect(fs.candidates[0].prompt).toBe(fillHeadSwapTemplate(HEAD_SWAP_Q5_TEMPLATE, TRAITS));
      expect(fs.candidates[2].prompt).toBe(HEAD_SWAP_Q4_PROMPT);
      const best = fs.candidates.reduce((bi: number, c: any, i: number) => (c.cost < fs.candidates[bi].cost ? i : bi), 0);
      expect(fs.chosen).toBe(best);
      expect(job.outputs.map((o: any) => o.id)).toEqual([fs.candidates[best].composite_file_id]);
      expect((await download(job.outputs[0].url)).equals(await h.ctx.store.read(await fileRow(fs.candidates[best].composite_file_id)))).toBe(true);
      expect(await candidateTurns(job.id)).toBe(3);
      // credits: its candidate turns + the describe turn if it paid it, and exactly what usage recorded for the job
      const sum = fs.candidates.reduce((s: number, c: any) => s + c.credits, 0) + fs.describe_credits;
      expect(job.credits).toBeCloseTo(sum, 6);
      expect(job.credits).toBeCloseTo(await usageTotal(job.id), 6);
    }
    // the Qoder turn saw the target as image 1 and the face as image 2, at the target's size
    const [row] = await db().select().from(conversations).where(and(sql`${conversations.metadata}->>'job_id' = ${b.jobs[0].id}`, sql`${conversations.metadata}->>'head_swap_candidate' = '0'`));
    const s = h.qoder.state.sessions.get(row!.qoderSessionId ?? b.jobs[0].request.face_swap.candidates[0].job_qoder_session)!;
    expect(s.resources.map((x) => x.mount_path)).toEqual(['/data/attachments/target.png', '/data/attachments/face.png']);
    expect(JSON.stringify(s)).toContain(TRAITS.expression);
    expect(JSON.stringify(s)).toContain('size=1024x1280');

    // a later batch on the same target reuses the cached description (no describe turn, no describe credits)
    describes = 0;
    const again = await finished((await json(await swap(target.id, { face_id: face.id }))).body.id);
    expect(describes).toBe(0);
    expect(again.jobs[0].request.face_swap).toMatchObject({ traits: TRAITS, describe_credits: 0 });
  });

  it('all_candidates: every successful composite is an output, best first in cost order; credits unchanged', async () => {
    const { target, face } = await setup();
    const r = await json(await swap(target.id, { face_id: face.id, engine: 'head_swap', all_candidates: true }));
    expect(r.body.jobs[0].request.face_swap.all_candidates).toBe(true);
    const job = (await finished(r.body.id)).jobs[0];
    expect(job.status).toBe('completed');
    const fs = job.request.face_swap;
    const order = fs.candidates.map((c: any, i: number) => ({ i, cost: c.cost })).sort((a: any, b: any) => a.cost - b.cost || a.i - b.i);
    expect(fs.chosen).toBe(order[0].i);
    expect(job.outputs.map((o: any) => o.id)).toEqual(order.map((o: any) => fs.candidates[o.i].composite_file_id));
    expect(job.credits).toBeCloseTo(await usageTotal(job.id), 6);
    // other engines ignore it
    const q = await json(await swap(target.id, { face_id: face.id, engine: 'qoder', all_candidates: true }));
    expect(q.body.jobs[0].request.face_swap.all_candidates).toBeUndefined();
    await finished(q.body.id);
  });

  it('with a portrait: portrait and combo references, the combo is built once and cached on the face, both images are identity sources', async () => {
    const { target, face, faceFile, portrait, faceBytes, portraitBytes } = await setup({ portrait: true });
    expect(face).toMatchObject({ portrait_file_id: portrait!.id, portrait: { id: portrait!.id } });
    const r = await json(await swap(target.id, { face_id: face.id }));
    const [row] = await db().select().from(faces).where(eq(faces.id, face.id));
    const combo = row!.comboFileId!;
    expect(combo).toBeTruthy();
    expect(r.body.jobs[0].request.face_swap).toMatchObject({ portrait_file_id: portrait!.id });
    expect(r.body.jobs[0].request.face_swap.candidates.map((c: any) => [c.reference_used, c.reference_file_id])).toEqual([
      ['portrait', portrait!.id],
      ['combo', combo],
      ['portrait', portrait!.id],
    ]);
    // portrait (10x20 → 700x1400) + 24 px gap + main image (4x4 → 1400x1400)
    const meta = await sharp(await h.ctx.store.read(await fileRow(combo))).metadata();
    expect([meta.width, meta.height]).toEqual([700 + 24 + 1400, 1400]);
    const job = (await finished(r.body.id)).jobs[0];
    expect(job.status).toBe('completed');
    const sources = sidecar.composites()[0]!.body.sources.map((s: string) => Buffer.from(s, 'base64'));
    expect(sources.map((s: Buffer) => s.equals(faceBytes) || s.equals(portraitBytes))).toEqual([true, true]);
    expect(sources[0].equals(faceBytes)).toBe(true);
    // combo candidate: image 2 is the combo
    const s = h.qoder.state.sessions.get(job.request.face_swap.candidates[1].job_qoder_session)!;
    expect(s.resources.map((x) => x.mount_path)).toEqual(['/data/attachments/target.png', '/data/attachments/face-combo.jpg']);

    // cached: the next batch reuses the combo
    const r2 = await json(await swap(target.id, { face_id: face.id }));
    expect(r2.body.jobs[0].request.face_swap.candidates[1].reference_file_id).toBe(combo);
    await finished(r2.body.id);

    // a new portrait drops the combo; null removes the portrait
    const other = await upload('portrait2.png', makePng(20, 20, [1, 1, 1]));
    const p = await json(await h.api(`/api/v1/faces/${face.id}`, { method: 'PATCH', json: { portrait_file_id: other.id } }));
    expect(p.body).toMatchObject({ portrait_file_id: other.id, name: 'Andi', file_id: faceFile.id });
    expect((await db().select().from(faces).where(eq(faces.id, face.id)))[0]!.comboFileId).toBeNull();
    const cleared = await json(await h.api(`/api/v1/faces/${face.id}`, { method: 'PATCH', json: { portrait_file_id: null } }));
    expect(cleared.body).toMatchObject({ portrait_file_id: null, portrait: null });
    const r3 = await json(await swap(target.id, { face_id: face.id }));
    expect(r3.body.jobs[0].request.face_swap.candidates.map((c: any) => c.reference_used)).toEqual(['primary', 'primary', 'primary']);
    await finished(r3.body.id);
  });

  it('skips failed candidates (Qoder or sidecar); fails with head_swap_failed only when all fail, credits kept', async () => {
    const { target, face } = await setup();
    // candidate 2 (Q4 prompt) fails in Qoder, one composite has no face
    h.qoder.setToolError((tool, text) => (text.includes('Make the person in image 1 the same person') ? 'image_gen error: content policy' : undefined));
    sidecar.failNext('/v1/head-composite', 422, 'NO_FACE_IN_GENERATED');
    const a = (await finished((await json(await swap(target.id, { face_id: face.id }))).body.id)).jobs[0];
    expect(a.status).toBe('completed');
    const fs = a.request.face_swap;
    expect(fs.candidates[2].error.code).toBe('generation_failed');
    expect(fs.candidates[2].file_id).toBeUndefined();
    const sidecarFailed = fs.candidates.filter((c: any) => c.error?.code === 'no_face_in_generated');
    expect(sidecarFailed).toHaveLength(1);
    expect(sidecarFailed[0].file_id).toBeTruthy();
    const ok = fs.candidates.findIndex((c: any) => c.composite_file_id);
    expect(fs.chosen).toBe(ok);
    expect(a.outputs.map((o: any) => o.id)).toEqual([fs.candidates[ok].composite_file_id]);
    expect(a.credits).toBeCloseTo(await usageTotal(a.id), 6);

    h.qoder.setToolError(undefined);
    sidecar.reset();
    for (let i = 0; i < 3; i++) sidecar.failNext('/v1/head-composite', 422, 'NO_FACE_IN_GENERATED');
    const b = (await finished((await json(await swap(target.id, { face_id: face.id }))).body.id)).jobs[0];
    expect(b.status).toBe('failed');
    expect(b.error.code).toBe('head_swap_failed');
    expect(b.error.message).toContain('no_face_in_generated');
    expect(b.outputs).toEqual([]);
    expect(b.credits).toBeGreaterThan(0);
    expect(b.credits).toBeCloseTo(await usageTotal(b.id), 6);
    expect(b.request.face_swap.chosen).toBeUndefined();
  });

  it('Qoder made no candidate at all (down, out of credits): the plain swapper finishes the job', async () => {
    const { target, face } = await setup();
    h.qoder.setToolError(() => 'image_gen error: billing_error You have no available credit.');
    const a = (await finished((await json(await swap(target.id, { face_id: face.id }))).body.id)).jobs[0];
    expect(a.status).toBe('completed');
    expect(a.request).toMatchObject({ qoder_fallback: 'faceswap', provider_used: 'faceswap', fallback_reason: 'head_swap_failed' });
    expect(a.request.face_swap.candidates.every((c: any) => c.error && !c.file_id)).toBe(true);
    expect(a.outputs).toHaveLength(1);
    expect(sidecar.calls.map((c) => c.path)).toEqual(['/v1/swap']);
  });

  it('an unusable description still runs with neutral wording (traits null, not cached)', async () => {
    const { target, face } = await setup();
    describeReply('sorry, I cannot help with that');
    const job = (await finished((await json(await swap(target.id, { face_id: face.id }))).body.id)).jobs[0];
    expect(job.status).toBe('completed');
    expect(job.request.face_swap.traits).toBeNull();
    expect(job.request.face_swap.candidates[0].prompt).toContain('In image 1 she has the hair shown in image 1');
    expect((await fileRow(target.id)).headTraits).toBeNull();
  });

  it('a restart resumes per candidate: finished work is kept, a cut-off turn is read back, a missing turn starts', async () => {
    const { target, face } = await setup();
    const first = (await finished((await json(await swap(target.id, { face_id: face.id }))).body.id)).jobs[0];
    const fs = first.request.face_swap;
    const [c0, c1, c2] = fs.candidates;
    // state at the "restart": candidate 0 done; candidate 1's turn was running (session known, nothing stored yet);
    // candidate 2's turn never started
    const resumedFs = {
      ...fs,
      chosen: undefined,
      candidates: [
        c0,
        { ...c1, file_id: undefined, composite_file_id: undefined, features: undefined, cost: undefined, credits: undefined, backend: undefined, last_event_id: null },
        { template_index: c2.template_index, reference: c2.reference, reference_used: c2.reference_used, reference_file_id: c2.reference_file_id },
      ],
    };
    const [copy] = await db()
      .insert(mediaJobs)
      .values({
        id: `img_hsresume${Date.now()}`,
        userId: h.userId,
        kind: 'image',
        status: 'in_progress',
        startedAt: new Date(),
        request: { ...first.request, face_swap: JSON.parse(JSON.stringify(resumedFs)) },
        batchId: `batch_hsresume${Date.now()}`,
      })
      .returning();
    sidecar.reset();
    describes = 0;
    await resumeAll();
    const done = (await finished(copy!.batchId!)).jobs[0];
    expect(done.status).toBe('completed');
    expect(describes).toBe(0); // traits were stored
    expect(sidecar.composites()).toHaveLength(2); // candidates 1 and 2 only
    expect(await candidateTurns(copy!.id)).toBe(1); // only candidate 2 got a new turn; candidate 1 was read back
    const out = done.request.face_swap;
    expect(out.candidates[0]).toEqual(c0);
    expect(out.candidates[1].job_qoder_session).toBe(c1.job_qoder_session);
    expect(out.candidates[1].file_id).toBeTruthy();
    expect(out.candidates[1].credits).toBeCloseTo(c1.credits, 6);
    expect(out.candidates[1].last_event_id).toBeTruthy();
    expect(out.candidates[2]).toMatchObject({ composite_file_id: expect.any(String), credits: expect.any(Number), prompt: HEAD_SWAP_Q4_PROMPT });
    // credits: the describe credits stored on the job (none were paid again) + all three candidates
    const expected = fs.describe_credits + c0.credits + out.candidates[1].credits + out.candidates[2].credits;
    expect(done.credits).toBeCloseTo(expected, 6);
    expect(typeof out.chosen).toBe('number');
  });
});

describe('head swap settings', () => {
  const admin = (path: string, init: RequestInit & { json?: unknown } = {}) => h.api(`/api/v1/admin/face-swap${path}`, { ...init, key: h.admin.apiKey });
  const ONE = 'A single experimental head swap candidate with {hair} kept.';

  it('PUT merges the head_swap block, validates templates and resets with null', async () => {
    try {
      const put = await json(await admin('/settings', { method: 'PUT', json: { head_swap: { eye_keep: false, swapper: { restorer: 'codeformer' } } } }));
      expect(put.status).toBe(200);
      expect(put.body.settings.head_swap).toEqual({ ...DEFAULT_HEAD_SWAP_SETTINGS, eye_keep: false, swapper: { ...DEFAULT_HEAD_SWAP_SETTINGS.swapper, restorer: 'codeformer' } });
      const p2 = await json(await admin('/settings', { method: 'PUT', json: { head_swap: { candidates: [{ template: ONE, reference: 'primary' }] } } }));
      expect(p2.body.settings.head_swap).toMatchObject({ eye_keep: false, candidates: [{ template: ONE, reference: 'primary' }], swapper: { restorer: 'codeformer' } });
      expect((await db().select().from(kv).where(eq(kv.key, 'face_swap.settings')))[0]!.value).toEqual({
        head_swap: { eye_keep: false, swapper: { restorer: 'codeformer' }, candidates: [{ template: ONE, reference: 'primary' }] },
      });
      for (const bad of [
        { head_swap: { candidates: [] } },
        { head_swap: { candidates: Array.from({ length: 7 }, () => ({ template: ONE, reference: 'primary' })) } },
        { head_swap: { candidates: [{ template: 'A template with an {unknown} placeholder in it.', reference: 'primary' }] } },
        { head_swap: { candidates: [{ template: ONE, reference: 'side' }] } },
        { head_swap: { candidates: [{ template: 'short', reference: 'primary' }] } },
        { head_swap: { describe_prompt: 'short' } },
        { head_swap: { nope: 1 } },
        { head_swap: { swapper: { restorer: 'x' } } },
      ]) {
        const r = await json(await admin('/settings', { method: 'PUT', json: bad }));
        expect(r.status, JSON.stringify(bad)).toBe(400);
        expect(r.body.error.code).toBe('validation_error');
      }
      const r1 = await json(await admin('/settings', { method: 'PUT', json: { head_swap: { swapper: null, eye_keep: null } } }));
      expect(r1.body.settings.head_swap).toEqual({ ...DEFAULT_HEAD_SWAP_SETTINGS, candidates: [{ template: ONE, reference: 'primary' }] });
      const r2 = await json(await admin('/settings', { method: 'PUT', json: { head_swap: null } }));
      expect(r2.body.settings).toEqual(DEFAULT_FACE_SWAP_SETTINGS);
      expect(await db().select().from(kv).where(eq(kv.key, 'face_swap.settings'))).toEqual([]);
    } finally {
      await db().delete(kv).where(eq(kv.key, 'face_swap.settings'));
      await h.ctx.faceSwapSettings.load();
    }
  });

  it('settings_override + tag apply to one admin batch (snapshot); the admin test stays swapper-only', async () => {
    const { target, face } = await setup({ key: h.admin.apiKey });
    const override = { head_swap: { candidates: [{ template: ONE, reference: 'portrait' }], eye_keep: false, swapper: { det_thresh: 0.3 } } };
    const r = await json(await swap(target.id, { face_id: face.id, settings_override: override, tag: 'hs-exp' }, h.admin.apiKey));
    expect(r.status).toBe(202);
    const fs = r.body.jobs[0].request.face_swap;
    expect(fs).toMatchObject({ engine: 'head_swap', tag: 'hs-exp', options: { ...DEFAULT_HEAD_SWAP_SETTINGS.swapper, det_thresh: 0.3 }, head_swap: { eye_keep: false } });
    expect(fs.candidates).toHaveLength(1);
    const job = (await finished(r.body.id, h.admin.apiKey)).jobs[0];
    expect(job.status).toBe('completed');
    expect(job.request.face_swap.candidates[0].prompt).toBe(`A single experimental head swap candidate with ${TRAITS.hair} kept.`);
    expect(sidecar.composites()).toHaveLength(1);
    expect(sidecar.composites()[0]!.body.options).toEqual({ swapper: { ...DEFAULT_HEAD_SWAP_SETTINGS.swapper, det_thresh: 0.3 }, eye_keep: false });
    expect(h.ctx.faceSwapSettings.get()).toEqual(DEFAULT_FACE_SWAP_SETTINGS);
    expect((await json(await h.api('/api/v1/admin/face-swap/jobs?tag=hs-exp', { key: h.admin.apiKey }))).body.data.map((j: any) => j.id)).toEqual([job.id]);

    const t = await json(await admin('/test', { method: 'POST', json: { target_file_id: target.id, face_id: face.id, engine: 'head_swap' } }));
    expect(t.status).toBe(400);
    expect(t.body.error.code).toBe('test_engine_unsupported');
  });
});

describe('faces: portrait', () => {
  it('validates portrait_file_id and keeps portrait + combo through housekeeping and job purges', async () => {
    const { face, portrait, target } = await setup({ portrait: true });
    const doc = await (async () => {
      const form = new FormData();
      form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'a.txt');
      return (await (await h.api('/api/v1/files', { method: 'POST', body: form })).json()) as { id: string };
    })();
    expect((await json(await h.api(`/api/v1/faces/${face.id}`, { method: 'PATCH', json: { portrait_file_id: doc.id } }))).status).toBe(400);
    expect((await json(await h.api(`/api/v1/faces/${face.id}`, { method: 'PATCH', json: { portrait_file_id: 'file_missing' } }))).body.error.code).toBe('file_not_found');
    expect((await json(await h.api(`/api/v1/faces/${face.id}`, { method: 'PATCH', json: { portrait_file_id: 5 } }))).status).toBe(400);
    const list = await json(await h.api('/api/v1/faces'));
    expect(list.body.data.find((f: any) => f.id === face.id)).toMatchObject({ portrait_file_id: portrait!.id, portrait: { id: portrait!.id, mime_type: 'image/png' } });

    const job = (await finished((await json(await swap(target.id, { face_id: face.id }))).body.id)).jobs[0];
    const combo = (await db().select().from(faces).where(eq(faces.id, face.id)))[0]!.comboFileId!;
    // trash + purge the job: candidate intermediates go, the face's images stay
    expect((await h.ctx.trash.trash([job.id], 'user', h.userId)).trashed).toEqual([job.id]);
    const counts = await h.ctx.trash.purge([job.id]);
    expect(counts.jobsPurged).toBe(1);
    for (const c of job.request.face_swap.candidates) {
      expect(await db().select().from(files).where(eq(files.id, c.composite_file_id))).toEqual([]);
      expect(await db().select().from(files).where(eq(files.id, c.file_id))).toEqual([]);
    }
    const kept = emptyCounts();
    await h.ctx.trash.removeUnused(await h.ctx.trash.fileRows([portrait!.id, combo]), { chats: 'all', counts: kept });
    expect(kept).toMatchObject({ filesInUse: 2, filesDeleted: 0 });
  });
});
