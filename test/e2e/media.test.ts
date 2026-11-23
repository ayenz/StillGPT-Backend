import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conversations, files, mediaJobs } from '../../src/db/schema.js';
import { makePng } from '../mock-qoder/index.js';
import { type Harness, startHarness } from './harness.js';
import { readSse } from './native-sse.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ mock: { videoDelayMs: 400 }, env: { MEDIA_POLL_INTERVAL_MS: '50', WEBHOOK_POLL_INTERVAL_MS: '50', VIDEO_CONCURRENCY: '1' } });
});
afterAll(() => h?.close());

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });

async function upload(filename: string, bytes: Buffer | string, type: string) {
  const form = new FormData();
  form.append('file', new Blob([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)], { type }), filename);
  return (await (await h.api('/api/v1/files', { method: 'POST', body: form })).json()) as { id: string };
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`waitFor timed out; last value: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const getJob = async (id: string) => (await json(await h.api(`/api/v1/jobs/${id}`))).body;

/** The tool_use input and user text the mock agent saw in the session of a job. */
function upstreamOf(sessionId: string, tool: string) {
  const s = h.qoder.state.sessions.get(sessionId)!;
  const use = s.events.find((e) => e.type === 'agent.tool_use' && e.name === tool);
  return { input: use?.input as Record<string, unknown> | undefined, text: s.userTexts.join('\n'), resources: s.resources.map((r) => r.mount_path) };
}

async function sessionOf(jobId: string) {
  const [row] = await h.ctx.database.db.select().from(mediaJobs).where(eq(mediaJobs.id, jobId));
  return row!.qoderSessionId!;
}

describe('images (native)', () => {
  it('generates synchronously with the requested size and a hidden conversation', async () => {
    const r = await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'kucing oranye di atap', size: '1792x1024' } }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: 'image', status: 'completed', progress: 100, request: { prompt: 'kucing oranye di atap', size: '1792x1024', enhance: false }, error: null });
    expect(r.body.credits).toBeCloseTo(0.06);
    expect(r.body.outputs).toHaveLength(1);
    expect(r.body.outputs[0]).toMatchObject({ kind: 'image', mime_type: 'image/png' });
    const img = await fetch(r.body.outputs[0].url);
    expect(img.headers.get('content-type')).toBe('image/png');

    const up = upstreamOf(await sessionOf(r.body.id), 'ImageGen');
    expect(up.input).toMatchObject({ size: '1792x1024' });
    expect(up.text).toContain('verbatim');
    expect(up.text).toContain('kucing oranye di atap');

    const list = await json(await h.api('/api/v1/conversations'));
    expect(list.body.data.every((c: any) => !c.title?.startsWith('image:'))).toBe(true);
    const hidden = await h.ctx.database.db.select().from(conversations).where(eq(conversations.profile, 'image'));
    expect(hidden[0]!.metadata).toMatchObject({ hidden: true, job_id: r.body.id });
  });

  it('runs async jobs observable via polling and SSE', async () => {
    const r = await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'langit', async: true } }));
    expect(r.status).toBe(202);
    expect(['queued', 'in_progress']).toContain(r.body.status);
    const events = await readSse(await h.api(`/api/v1/jobs/${r.body.id}/events`));
    expect(events[0]!.event).toBe('job');
    expect(events.at(-1)).toMatchObject({ event: 'completed', data: { id: r.body.id, status: 'completed' } });
    expect((await getJob(r.body.id)).status).toBe('completed');

    const jobs = await json(await h.api('/api/v1/jobs?kind=image&limit=10'));
    expect(jobs.body.data.map((j: any) => j.id)).toContain(r.body.id);
    // a terminal job's event stream is just the snapshot
    const again = await readSse(await h.api(`/api/v1/jobs/${r.body.id}/events`));
    expect(again.map((e) => e.event)).toEqual(['job']);
  });

  it('edits: input images are mounted and passed as tool paths; enhance runs the prompt enhancer first', async () => {
    h.qoder.setReply((text) => (text.includes('<idea>') ? '{"prompt":"Merge both photos into one sunny beach scene","aspect_ratio":"16:9"}' : undefined));
    const a = await upload('foto.png', makePng(), 'image/png');
    const b = await upload('foto.png', makePng(4, 4), 'image/png');
    const r = await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'gabungkan', input_file_ids: [a.id, b.id], enhance: true } }));
    h.qoder.setReply(undefined);
    expect(r.body.status).toBe('completed');
    expect(r.body.request).toMatchObject({ prompt: 'Merge both photos into one sunny beach scene', original_prompt: 'gabungkan', size: '1024x1024' /* edits keep the input's shape */, enhance: true, provider_used: 'qoder' });
    const up = upstreamOf(await sessionOf(r.body.id), 'ImageGen');
    expect(up.resources).toEqual(['/data/attachments/foto.png', '/data/attachments/foto-2.png']);
    expect(up.text).toContain('["/data/attachments/foto.png","/data/attachments/foto-2.png"]');
    expect(up.text).toContain('verbatim');
    expect(up.text).toContain('Merge both photos into one sunny beach scene');
  });

  it('marks failed generations', async () => {
    const r = await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'rusak [[error]]' } }));
    expect(r.body.status).toBe('failed');
    expect(r.body.error.code).toBeTruthy();
    expect(r.body.outputs).toEqual([]);
  });

  it('validates input', async () => {
    const bad = async (path: string, payload: unknown, status = 400) => {
      const r = await json(await h.api(path, { method: 'POST', json: payload }));
      expect(r.status, JSON.stringify(payload)).toBe(status);
      return r.body.error;
    };
    expect((await bad('/api/v1/images', { prompt: 'x', size: '640x480' })).code).toBe('validation_error');
    expect((await bad('/api/v1/images', { size: '1024x1024' })).message).toContain('prompt');
    expect((await bad('/api/v1/images', { prompt: 'x', input_file_ids: ['a', 'b', 'c', 'd'] })).message).toContain('input_file_ids');
    expect((await bad('/api/v1/images', { prompt: 'x', input_file_ids: ['file_missing'] }, 404)).code).toBe('file_not_found');
    const doc = await upload('a.txt', 'hello', 'text/plain');
    expect((await bad('/api/v1/images', { prompt: 'x', input_file_ids: [doc.id] })).message).toContain('not an image');
    expect((await bad('/api/v1/images', { prompt: 'x', callback_url: 'ftp://x' })).code).toBe('validation_error');
    expect((await bad('/api/v1/videos', { prompt: 'x', seconds: 31 })).message).toContain('seconds');
    expect((await bad('/api/v1/videos', { prompt: 'x', seconds: 1 })).code).toBe('validation_error');
    expect((await bad('/api/v1/videos', { prompt: 'x', ratio: '2:1' })).code).toBe('validation_error');
    expect((await bad('/api/v1/videos', { prompt: 'x', resolution: '4K' })).code).toBe('validation_error');
    const png = await upload('f.png', makePng(), 'image/png');
    expect((await bad('/api/v1/videos', { prompt: 'x', first_frame_file_id: png.id, reference_file_ids: [png.id] })).message).toContain('cannot be combined');
    expect((await bad('/api/v1/videos', { prompt: 'x', last_frame_file_id: png.id })).message).toContain('first frame');
    expect((await bad('/api/v1/videos', { prompt: 'x', reference_file_ids: Array(11).fill(png.id) })).code).toBe('validation_error');
    expect((await h.api('/api/v1/jobs/vid_nope')).status).toBe(404);
    expect((await h.api('/api/v1/jobs?kind=audio')).status).toBe(400);
  });
});

describe('videos (native)', () => {
  it('queues, runs one at a time, completes with a seekable MP4', async () => {
    const first = await json(await h.api('/api/v1/videos', { method: 'POST', json: { prompt: 'ombak pantai', seconds: 8, ratio: '9:16', resolution: '720P', audio: false } }));
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ kind: 'video', request: { mode: 'text_to_video', seconds: 8, ratio: '9:16', resolution: '720P', audio: false } });
    const second = await json(await h.api('/api/v1/videos', { method: 'POST', json: { prompt: 'gunung' } }));
    expect(second.body.status).toBe('queued');
    expect(second.body.request).toMatchObject({ seconds: 5, ratio: '16:9', resolution: '1080P', audio: true });

    await waitFor(() => getJob(first.body.id), (j) => j.status === 'in_progress');
    expect((await getJob(second.body.id)).status).toBe('queued'); // concurrency 1

    const events = await readSse(await h.api(`/api/v1/jobs/${first.body.id}/events`));
    const done = events.at(-1)!;
    expect(done.event).toBe('completed');
    expect(done.data.outputs[0]).toMatchObject({ kind: 'video', mime_type: 'video/mp4' });
    expect(done.data.credits).toBeCloseTo(0.21);
    expect(done.data.completed_at).toBeTruthy();

    const up = upstreamOf(await sessionOf(first.body.id), 'VideoGen');
    expect(up.input).toMatchObject({ duration_seconds: 8, ratio: '9:16', resolution: '720P' });

    const url = done.data.outputs[0].url;
    const whole = await fetch(url);
    const size = (await whole.arrayBuffer()).byteLength;
    const part = await fetch(url, { headers: { range: 'bytes=0-7' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 0-7/${size}`);
    expect(Buffer.from(await part.arrayBuffer()).subarray(4, 8).toString()).toBe('ftyp');

    const second2 = await waitFor(() => getJob(second.body.id), (j) => j.status === 'completed');
    expect(second2.progress).toBe(100);
  });

  it('first frame mode mounts the image and passes it as media.first_frame', async () => {
    const png = await upload('awal.png', makePng(), 'image/png');
    const r = await json(await h.api('/api/v1/videos', { method: 'POST', json: { prompt: 'bergerak', first_frame_file_id: png.id, last_frame_file_id: png.id } }));
    expect(r.body.request).toMatchObject({ mode: 'first_frame_to_video', ratio: 'adaptive' });
    const job = await waitFor(() => getJob(r.body.id), (j) => j.status === 'completed');
    const up = upstreamOf(await sessionOf(job.id), 'VideoGen');
    expect(up.resources).toEqual(['/data/attachments/awal.png', '/data/attachments/awal-2.png']);
    expect(up.text).toContain('"first_frame":{"type":"image","source":"/data/attachments/awal.png"}');
    expect(up.text).toContain('"last_frame":{"type":"image","source":"/data/attachments/awal-2.png"}');
  });
});

describe('restart recovery', () => {
  it('finishes an in-progress job from upstream events and re-runs queued ones', async () => {
    // Simulate a crash: the upstream session runs, but no TurnRunner in this process is watching it.
    const agent = await h.ctx.agents.agentId('video');
    const session = await h.ctx.qoder.createSession({ agent, environment_id: await h.ctx.agents.environmentId() });
    await h.ctx.qoder.sendEvents(session.id, [{ type: 'user.message', content: [{ type: 'text', text: 'Parameters: seconds=4\n\nPrompt:\nhujan' }] }]);
    const [orphan] = await h.ctx.database.db
      .insert(mediaJobs)
      .values({ id: 'vid_orphan', userId: h.userId, kind: 'video', status: 'in_progress', qoderSessionId: session.id, startedAt: new Date(), request: { prompt: 'hujan', mode: 'text_to_video', seconds: 4, resolution: '1080P', ratio: '16:9', audio: true } })
      .returning();
    const [queued] = await h.ctx.database.db
      .insert(mediaJobs)
      .values({ id: 'img_queued', userId: h.userId, kind: 'image', status: 'queued', request: { prompt: 'antre', size: '1024x1024', enhance: false, input_file_ids: [] } })
      .returning();

    await h.ctx.media.stop();
    h.ctx.media.start();

    const done = await waitFor(() => getJob(orphan!.id), (j) => j.status !== 'in_progress');
    expect(done).toMatchObject({ status: 'completed', progress: 100 });
    expect(done.outputs[0]).toMatchObject({ kind: 'video', mime_type: 'video/mp4' });
    expect(done.credits).toBeCloseTo(0.21);
    expect((await fetch(done.outputs[0].url)).status).toBe(200);

    const img = await waitFor(() => getJob(queued!.id), (j) => j.status === 'completed');
    expect(img.outputs).toHaveLength(1);

    const usage = await json(await h.api('/api/v1/usage'));
    expect(usage.body.by_kind.video.credits).toBeGreaterThan(0);
  });
});

describe('editing a generated image', () => {
  it('uploads our own copy when Qoder refuses to mount its own output (agent_output)', async () => {
    const first = await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'a red lantern', provider: 'qoder' } }));
    expect(first.body.status).toBe('completed');
    const generated = first.body.outputs[0];
    const [before] = await h.ctx.database.db.select().from(files).where(eq(files.id, generated.id));
    expect(before!.qoderFileId).toBeTruthy(); // the id of Qoder's own output
    const edit = await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'make the lantern blue', provider: 'qoder', input_file_ids: [generated.id] } }));
    expect(edit.body.status, JSON.stringify(edit.body.error)).toBe('completed');
    const [after] = await h.ctx.database.db.select().from(files).where(eq(files.id, generated.id));
    // re-uploaded once: the cached id now points at our upload, which mounts
    expect(after!.qoderFileId).not.toBe(before!.qoderFileId);
  });
});
