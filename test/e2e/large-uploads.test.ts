import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shrinkImage } from '../../src/core/attachments.js';
import { type Harness, startHarness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ env: { MEDIA_POLL_INTERVAL_MS: '50' } });
});
afterAll(() => h?.close());

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });

/** Noise does not compress: a ~15 MB PNG. */
const noisePng = (w = 2600, hgt = 2000) => sharp(randomBytes(w * hgt * 3), { raw: { width: w, height: hgt, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer();

async function upload(bytes: Buffer, type = 'image/png', name = 'big.png') {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type }), name);
  return json(await h.api('/api/v1/files', { method: 'POST', body: form }));
}

describe('large uploads', () => {
  it('shrinkImage keeps the format and fits the target', async () => {
    const big = await noisePng();
    expect(big.length).toBeGreaterThan(10 * 1024 * 1024);
    const small = await shrinkImage(big, 'image/png');
    expect(small.length).toBeLessThanOrEqual(4.5 * 1024 * 1024);
    expect((await sharp(small).metadata()).format).toBe('png');
  });

  it('accepts a >20 MB file and rejects >50 MB', async () => {
    const ok = await upload(randomBytes(25 * 1024 * 1024), 'application/octet-stream', 'blob.bin');
    expect(ok.status).toBe(201);
    const tooBig = await upload(randomBytes(51 * 1024 * 1024), 'application/octet-stream', 'huge.bin');
    expect(tooBig.status).toBe(413);
  });

  it('a large image works as an edit input: Qoder gets a shrunk copy, the original stays', async () => {
    const big = await noisePng();
    const up = await upload(big);
    expect(up.body.size).toBe(big.length);
    const r = await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'make it brighter', input_file_ids: [up.body.id] } }));
    expect(r.body.status).toBe('completed');
    const sent = [...h.qoder.state.files.values()].find((f) => f.filename === 'big.png');
    expect(sent).toBeTruthy();
    expect(sent!.size_bytes).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(sent!.mime_type).toBe('image/png');
  });

  it('a large image is accepted in chat', async () => {
    const up = await upload(await noisePng(), 'image/png', 'chat.png');
    const conv = await json(await h.api('/api/v1/conversations', { method: 'POST', json: {} }));
    const r = await h.api(`/api/v1/conversations/${conv.body.id}/messages`, { method: 'POST', json: { content: [{ type: 'text', text: 'apa ini?' }, { type: 'image', file_id: up.body.id }] } });
    expect(r.status).toBe(200);
  }, 60_000);
});
