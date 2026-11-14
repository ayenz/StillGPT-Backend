import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeMp4 } from '../mock-qoder/index.js';
import { type Harness, startHarness } from './harness.js';

/** Gallery delivery: thumbnails/previews, stable signed URLs, caching, streaming ranges. */

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

let h: Harness;
beforeAll(async () => {
  h = await startHarness({});
});
afterAll(() => h?.close());

async function upload(harness: Harness, filename: string, bytes: Buffer | string, type: string) {
  const form = new FormData();
  form.append('file', new Blob([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)], { type }), filename);
  const res = await harness.api('/api/v1/files', { method: 'POST', body: form });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; url: string; thumbnail_url: string | null; preview_url: string | null };
}

/** Blurred noise: compresses about like a real photo / generated image. */
async function bigPng(width: number, height: number) {
  const raw = randomBytes(width * height * 3);
  return sharp(raw, { raw: { width, height, channels: 3 } }).blur(1.5).png().toBuffer();
}

describe('image variants', () => {
  let png: Buffer;
  let file: Awaited<ReturnType<typeof upload>>;
  beforeAll(async () => {
    png = await bigPng(2000, 1500);
    file = await upload(h, 'big.png', png, 'image/png');
  });

  it('lists thumbnail and preview URLs next to the original', () => {
    expect(file.url).toContain(`/media/${file.id}?`);
    expect(file.thumbnail_url).toBe(`${file.url}&variant=thumb`);
    expect(file.preview_url).toBe(`${file.url}&variant=preview`);
  });

  it('serves downscaled WebP renditions', async () => {
    for (const [url, max] of [
      [file.thumbnail_url!, 400],
      [file.preview_url!, 1280],
    ] as const) {
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/webp');
      const body = Buffer.from(await res.arrayBuffer());
      expect(Number(res.headers.get('content-length'))).toBe(body.length);
      const meta = await sharp(body).metadata();
      expect(meta.format).toBe('webp');
      expect(Math.max(meta.width!, meta.height!)).toBe(max);
      expect(meta.width! / meta.height!).toBeCloseTo(2000 / 1500, 1);
      expect(body.length).toBeLessThan(png.length / 4);
    }
  });

  it('never upscales small images', async () => {
    const small = await upload(h, 'small.png', await bigPng(120, 80), 'image/png');
    const meta = await sharp(Buffer.from(await (await fetch(small.thumbnail_url!)).arrayBuffer())).metadata();
    expect([meta.width, meta.height]).toEqual([120, 80]);
  });

  it('caches renditions on disk next to the original', async () => {
    await fetch(file.thumbnail_url!);
    const stored = await h.ctx.store.get(file.id);
    const cached = await readFile(`${h.ctx.store.pathOf(stored)}.thumb.v1.webp`);
    expect(Buffer.from(await (await fetch(file.thumbnail_url!)).arrayBuffer()).equals(cached)).toBe(true);
  });

  it('rejects unknown variants and bad signatures', async () => {
    expect((await fetch(file.url + '&variant=huge')).status).toBe(400);
    expect((await fetch(file.thumbnail_url!.replace(/sig=[^&]+/, 'sig=nope'))).status).toBe(403);
  });

  it('falls back to the original when an image cannot be decoded', async () => {
    const broken = await upload(h, 'broken.png', 'not really a png', 'image/png');
    const res = await fetch(broken.thumbnail_url!);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    expect(await res.text()).toBe('not really a png');
  });

  it('has no variants for non-raster files', async () => {
    const svg = await upload(h, 'logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml');
    const txt = await upload(h, 'a.txt', 'hello', 'text/plain');
    for (const f of [svg, txt]) expect([f.thumbnail_url, f.preview_url]).toEqual([null, null]);
    expect((await fetch(`${txt.url}&variant=thumb`)).status).toBe(404);
  });
});

describe('caching', () => {
  it('returns the same signed URL on repeated reads so browsers can cache it', async () => {
    const f = await upload(h, 'c.png', await bigPng(50, 50), 'image/png');
    const again = (await (await h.api(`/api/v1/files/${f.id}`)).json()) as typeof f;
    expect(again.url).toBe(f.url);
    expect(again.thumbnail_url).toBe(f.thumbnail_url);
    const exp = Number(new URL(f.url).searchParams.get('exp'));
    expect(exp % 86400).toBe(0);
    expect(exp - Date.now() / 1000).toBeGreaterThanOrEqual(h.ctx.config.MEDIA_URL_TTL_SEC - 5);
  });

  it('sends immutable cache headers and answers If-None-Match with 304', async () => {
    const f = await upload(h, 'd.png', await bigPng(60, 60), 'image/png');
    for (const url of [f.url, f.thumbnail_url!]) {
      const res = await fetch(url);
      const etag = res.headers.get('etag')!;
      expect(etag).toMatch(/^".+"$/);
      expect(res.headers.get('cache-control')).toMatch(/^private, max-age=\d+, immutable$/);
      const revalidated = await fetch(url, { headers: { 'if-none-match': etag } });
      expect(revalidated.status).toBe(304);
      expect(await revalidated.text()).toBe('');
    }
    const thumbTag = (await fetch(f.thumbnail_url!)).headers.get('etag');
    expect(thumbTag).not.toBe((await fetch(f.url)).headers.get('etag'));
  });
});

describe('streaming ranges', () => {
  const data = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  let url: string;
  beforeAll(async () => {
    url = (await upload(h, 'blob.bin', data, 'application/octet-stream')).url;
  });

  it('serves byte ranges from disk', async () => {
    const cases: [string, number, number][] = [
      ['bytes=0-9', 0, 9],
      ['bytes=990-', 990, 999],
      ['bytes=-5', 995, 999],
      ['bytes=500-5000', 500, 999],
    ];
    for (const [range, start, end] of cases) {
      const res = await fetch(url, { headers: { range } });
      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe(`bytes ${start}-${end}/1000`);
      expect(Buffer.from(await res.arrayBuffer()).equals(data.subarray(start, end + 1))).toBe(true);
    }
    expect((await fetch(url, { headers: { range: 'bytes=2000-' } })).status).toBe(416);
    const full = await fetch(url);
    expect(full.status).toBe(200);
    expect(Buffer.from(await full.arrayBuffer()).equals(data)).toBe(true);
  });

  it('ignores a range whose If-Range no longer matches', async () => {
    const res = await fetch(url, { headers: { range: 'bytes=0-9', 'if-range': '"stale"' } });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
  });
});

describe('video posters', () => {
  it('has no video variants without ffmpeg', async () => {
    const noFf = await startHarness({ env: { FFMPEG_PATH: '' } });
    try {
      const f = await upload(noFf, 'clip.mp4', makeMp4(), 'video/mp4');
      expect([f.thumbnail_url, f.preview_url]).toEqual([null, null]);
      expect((await fetch(`${f.url}&variant=thumb`)).status).toBe(404);
    } finally {
      await noFf.close();
    }
  });

  it.skipIf(!hasFfmpeg)('renders a still frame for videos with ffmpeg', async () => {
    const out = join(tmpdir(), `stillgpt-test-${process.pid}.mp4`);
    const made = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=10:duration=2', '-pix_fmt', 'yuv420p', out]);
    expect(made.status).toBe(0);
    const f = await upload(h, 'clip.mp4', await readFile(out), 'video/mp4');
    expect(f.thumbnail_url).toBe(`${f.url}&variant=thumb`);
    for (const [url, w, hgt] of [
      [f.preview_url!, 1280, 720],
      [f.thumbnail_url!, 400, 225],
    ] as const) {
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/webp');
      const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
      expect([meta.width, meta.height]).toEqual([w, hgt]);
    }
    // an undecodable "video" has no poster
    const bogus = await upload(h, 'bogus.mp4', makeMp4(), 'video/mp4');
    expect((await fetch(bogus.thumbnail_url!)).status).toBe(404);
  });
});
