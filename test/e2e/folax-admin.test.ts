import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cycleStart } from '../../src/routes/native/folax.js';
import { type FakeFolax, startFakeFolax } from '../fake-folax/index.js';
import { makePng } from '../mock-qoder/index.js';
import { type Harness, startHarness } from './harness.js';

/** GET /admin/folax/status: the shared quota next to what StillGPT itself used this cycle. */

let folax: FakeFolax;
let h: Harness;
beforeAll(async () => {
  folax = await startFakeFolax();
  h = await startHarness({ env: { FOLAX_URL: folax.url, FOLAX_API_KEY: folax.key, MEDIA_POLL_INTERVAL_MS: '50', FOLAX_VIDEO_POLL_MS: '20' } });
});
afterAll(async () => {
  await h?.close();
  await folax?.close();
});

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });
async function upload() {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(makePng())], { type: 'image/png' }), 'in.png');
  return (await (await h.api('/api/v1/files', { method: 'POST', body: form })).json()) as { id: string };
}
async function waitDone(id: string) {
  for (let i = 0; i < 400; i++) {
    const j = (await json(await h.api(`/api/v1/jobs/${id}`))).body;
    if (j.status === 'completed' || j.status === 'failed') return j;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('job did not finish');
}

describe('cycleStart', () => {
  it('is reset_at minus a week, else the last Monday 00:00 UTC', () => {
    const q = { total: 20, remaining: 1, reset_at: '2026-11-23T00:00:00Z', cycle: 'weekly', observed_at: null, source: 'observed' as const };
    expect(cycleStart({ video: q, edit: q }).toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(cycleStart(null, new Date('2026-11-19T15:00:00Z')).toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(cycleStart(null, new Date('2026-11-16T00:30:00Z')).toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(cycleStart(null, new Date('2026-11-15T23:59:00Z')).toISOString()).toBe('2026-11-09T00:00:00.000Z');
  });
});

describe('GET /admin/folax/status', () => {
  it('counts StillGPT usage this cycle (per user) and what was used outside StillGPT', async () => {
    const img = await upload();
    // quota users: one prompt edit and one video; free: one chat turn; plus a failed edit (not counted)
    expect((await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'langit senja', input_file_ids: [img.id], provider: 'folax' } }))).body.status).toBe('completed');
    folax.failNext('POST /v1/images/edits', 422, 'content_rejected');
    expect((await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'x', input_file_ids: [img.id], provider: 'folax' } }))).body.status).toBe('failed');
    const video = await json(await h.api('/api/v1/videos', { method: 'POST', json: { prompt: 'angin', first_frame_file_id: img.id, provider: 'folax' } }));
    expect((await waitDone(video.body.id)).status).toBe('completed');
    const conv = await json(await h.api('/api/v1/conversations', { method: 'POST', json: { model: 'folax/chatgpt' } }));
    await h.api(`/api/v1/conversations/${conv.body.id}/messages`, { method: 'POST', json: { text: 'halo' } });

    // Folax says 12 of 20 videos are left: 1 is ours, so 7 went elsewhere; edits were never observed → unknown
    const r = await json(await h.api('/api/v1/admin/folax/status', { key: h.admin.apiKey }));
    expect(r.status).toBe(200);
    expect(r.body.stillgpt_usage).toMatchObject({ videos: 1, edits: 1, chat_turns: 1 });
    expect(r.body.stillgpt_usage.by_user).toEqual([{ user_id: h.userId, email: 'user@test.local', videos: 1, edits: 1, chat_turns: 1 }]);
    expect(r.body.stillgpt_usage.since).toBe('2026-11-16T00:00:00.000Z');
    expect(r.body.outside_usage).toEqual({ videos: 7, edits: null });

    // users get no admin details
    const user = await json(await h.api('/api/v1/folax/status'));
    expect(user.body.stillgpt_usage).toBeUndefined();
    expect((await h.api('/api/v1/admin/folax/status')).status).toBe(403);
  });
});
