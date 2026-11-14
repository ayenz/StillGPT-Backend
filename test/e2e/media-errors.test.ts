import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';

const QUEUE_FULL =
  'video_gen error: submit failed: video create HTTP 502: CreateVideo: {"code":"invalid_request_error","message":"bailian happyhorse status=429 body=map[code:Throttling.QueueQuota message:Task queue limit exceeded, please try again later. request_id:85ea]"}';

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ env: { MEDIA_POLL_INTERVAL_MS: '20', MEDIA_QUEUE_RETRY_DELAYS_MS: '50,50' } });
});
afterEach(() => h.qoder.setToolError(undefined));
afterAll(() => h?.close());

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });
async function waitForJob(id: string) {
  for (let i = 0; i < 300; i++) {
    const job = (await json(await h.api(`/api/v1/jobs/${id}`))).body;
    if (job.status === 'completed' || job.status === 'failed') return job;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`job ${id} did not finish`);
}

describe('generator failures reported by Qoder tools', () => {
  it('retries a video while the upstream queue is full, then succeeds', async () => {
    let calls = 0;
    h.qoder.setToolError((tool) => (tool === 'VideoGen' && ++calls <= 2 ? QUEUE_FULL : undefined));
    const created = await json(await h.api('/api/v1/videos', { method: 'POST', json: { prompt: 'golden retriever in Seoul', seconds: 2 } }));
    const job = await waitForJob(created.body.id);
    expect(job.status).toBe('completed');
    expect(job.outputs).toHaveLength(1);
    expect(calls).toBe(3);
  });

  it('gives up with upstream_queue_full after the configured retries', async () => {
    h.qoder.setToolError(() => QUEUE_FULL);
    const created = await json(await h.api('/api/v1/videos', { method: 'POST', json: { prompt: 'waves', seconds: 2 } }));
    const job = await waitForJob(created.body.id);
    expect(job.status).toBe('failed');
    expect(job.error.code).toBe('upstream_queue_full');
    expect(job.error.message).toMatch(/queue is full/);
  });

  it('surfaces other generator errors instead of a generic no_output', async () => {
    h.qoder.setToolError(() => 'image_gen error: content policy violation detected request_id:abc123');
    const r = await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'something', provider: 'qoder' } }));
    expect(r.body.status).toBe('failed');
    expect(r.body.error.code).toBe('generation_failed');
    expect(r.body.error.message).toContain('content policy violation');
    expect(r.body.error.message).not.toContain('abc123');
  });
});

describe('MIME type of generated files', () => {
  it('replaces a generic upstream content type using magic bytes / extension', async () => {
    const { inferMimeType } = await import('../../src/core/storage.js');
    const mp4 = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    expect(inferMimeType('ocean.mp4', mp4, 'application/octet-stream')).toBe('video/mp4');
    expect(inferMimeType('clip.bin', mp4, '')).toBe('video/mp4');
    expect(inferMimeType('report.pdf', Buffer.from('%PDF-1.4'), 'application/octet-stream')).toBe('application/pdf');
    expect(inferMimeType('notes.docx', Buffer.from('PK\x03\x04'), undefined)).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(inferMimeType('a.png', Buffer.from('x'), 'image/png; charset=binary')).toBe('image/png');
    expect(inferMimeType('mystery', Buffer.from('xyz'), 'application/octet-stream')).toBe('application/octet-stream');
  });
});
