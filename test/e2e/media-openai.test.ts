import OpenAI, { toFile } from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nearestImageSize, paramsToVideoSize, videoSizeToParams } from '../../src/routes/openai/media.js';
import { makePng } from '../mock-qoder/index.js';
import { type Harness, startHarness } from './harness.js';

let h: Harness;
let client: OpenAI;
beforeAll(async () => {
  h = await startHarness({ mock: { videoDelayMs: 150 }, env: { MEDIA_POLL_INTERVAL_MS: '50' } });
  client = new OpenAI({ apiKey: h.apiKey, baseURL: `${h.url}/v1`, maxRetries: 0 });
});
afterAll(() => h?.close());

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });

describe('size mapping', () => {
  it('maps OpenAI sizes onto Qoder parameters', () => {
    expect(nearestImageSize(undefined)).toBe('1024x1024');
    expect(nearestImageSize('auto')).toBe('1024x1024');
    expect(nearestImageSize('1536x1024')).toBe('1536x1024');
    expect(nearestImageSize('512x512')).toBe('1024x1024');
    expect(nearestImageSize('1920x1080')).toBe('1792x1024');
    expect(nearestImageSize('1080x1920')).toBe('1024x1792');
    expect(videoSizeToParams('1280x720')).toEqual({ ratio: '16:9', resolution: '720P' });
    expect(videoSizeToParams('720x1280')).toEqual({ ratio: '9:16', resolution: '720P' });
    expect(videoSizeToParams('1920x1080')).toEqual({ ratio: '16:9', resolution: '1080P' });
    expect(videoSizeToParams('1024x1024')).toEqual({ ratio: '1:1', resolution: '1080P' });
    expect(paramsToVideoSize('9:16', '720P')).toBe('720x1280');
    expect(paramsToVideoSize('16:9', '1080P')).toBe('1920x1080');
  });
});

describe('/v1/images (openai SDK)', () => {
  it('images.generate returns URLs or base64', async () => {
    const r = await client.images.generate({ model: 'qoder-image', prompt: 'kucing', size: '1536x1024' });
    expect(r.created).toBeGreaterThan(0);
    expect(r.data).toHaveLength(1);
    const res = await fetch(r.data![0]!.url!);
    expect(res.headers.get('content-type')).toBe('image/png');

    const two = await client.images.generate({ model: 'qoder-image', prompt: 'anjing', n: 2, response_format: 'b64_json' });
    expect(two.data).toHaveLength(2);
    expect(Buffer.from(two.data![0]!.b64_json!, 'base64').subarray(1, 4).toString()).toBe('PNG');
  });

  it('images.edit accepts uploaded images', async () => {
    const r = await client.images.edit({ model: 'gpt-image-1', image: await toFile(makePng(), 'in.png', { type: 'image/png' }), prompt: 'tambahkan topi' });
    expect(r.data![0]!.url).toContain('/media/');
    const jobs = await h.ctx.media.listJobs(h.userId, { kind: 'image', limit: 1 });
    expect(jobs[0]!.request.input_file_ids).toHaveLength(1);
  });

  it('uses the OpenAI error envelope', async () => {
    await expect(client.images.generate({ model: 'qoder-image', prompt: 'x', n: 9 })).rejects.toMatchObject({ status: 400, code: 'invalid_n' });
    await expect(client.images.generate({ model: 'gpt-4o', prompt: 'x' })).rejects.toMatchObject({ status: 400, code: 'model_not_found' });
    const res = await json(await h.api('/v1/images/generations', { method: 'POST', json: { prompt: 'x [[error]]' } }));
    expect(res.status).toBe(502);
    expect(res.body.error).toMatchObject({ type: 'server_error', message: expect.any(String) });
    expect((await fetch(`${h.url}/v1/images/generations`, { method: 'POST' })).status).toBe(401);
  });
});

describe('/v1/videos (OpenAI Videos API shape)', () => {
  it('creates, polls, downloads with Range', async () => {
    const created = await json(await h.api('/v1/videos', { method: 'POST', json: { model: 'qoder-video', prompt: 'air terjun', seconds: '4', size: '720x1280' } }));
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ object: 'video', model: 'qoder-video', seconds: '4', size: '720x1280', error: null });
    expect(['queued', 'in_progress']).toContain(created.body.status);

    let video = created.body;
    for (let i = 0; i < 200 && video.status !== 'completed'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      video = (await json(await h.api(`/v1/videos/${created.body.id}`))).body;
    }
    expect(video).toMatchObject({ status: 'completed', progress: 100 });
    expect(video.completed_at).toBeGreaterThanOrEqual(video.created_at);

    const full = await h.api(`/v1/videos/${video.id}/content`);
    expect(full.headers.get('content-type')).toBe('video/mp4');
    const size = (await full.arrayBuffer()).byteLength;
    const part = await h.api(`/v1/videos/${video.id}/content`, { headers: { range: 'bytes=4-7' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 4-7/${size}`);
    expect(Buffer.from(await part.arrayBuffer()).toString()).toBe('ftyp');

    const list = await json(await h.api('/v1/videos'));
    expect(list.body).toMatchObject({ object: 'list' });
    expect(list.body.data.map((v: any) => v.id)).toContain(video.id);

    const del = await json(await h.api(`/v1/videos/${video.id}`, { method: 'DELETE' }));
    expect(del.status).toBe(501);
    expect(del.body.error.code).toBe('not_supported');
  });

  it('multipart with input_reference becomes a first-frame video', async () => {
    const form = new FormData();
    form.append('prompt', 'mulai dari foto ini');
    form.append('seconds', '6');
    form.append('size', '1280x720');
    form.append('audio', 'false');
    form.append('input_reference', new Blob([new Uint8Array(makePng())], { type: 'image/png' }), 'ref.png');
    const created = await json(await h.api('/v1/videos', { method: 'POST', body: form }));
    expect(created.body).toMatchObject({ seconds: '6', size: '1280x720' });
    const job = await h.ctx.media.getJob(created.body.id, h.userId);
    expect(job.request).toMatchObject({ mode: 'first_frame_to_video', ratio: '16:9', resolution: '720P', audio: false });
  });

  it('rejects bad input and unfinished downloads', async () => {
    expect((await json(await h.api('/v1/videos', { method: 'POST', json: { prompt: 'x', seconds: '99' } }))).status).toBe(400);
    expect((await json(await h.api('/v1/videos', { method: 'POST', json: { prompt: 'x', size: 'big' } }))).body.error.code).toBe('invalid_size');
    const created = await json(await h.api('/v1/videos', { method: 'POST', json: { prompt: 'x', seconds: 2 } }));
    const early = await json(await h.api(`/v1/videos/${created.body.id}/content`));
    expect(early.status).toBe(409);
    expect((await h.api('/v1/videos/vid_missing')).status).toBe(404);
  });
});
