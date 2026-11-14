import { spawn } from 'node:child_process';
import { rename, rm, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

/**
 * Downscaled renditions served by `GET /media/:id?variant=…` so galleries don't load originals:
 * - `thumb`   — grid tiles (fits in 400×400)
 * - `preview` — lightbox / detail view (fits in 1280×1280)
 * Images are resized; videos get a still frame (poster). Always WebP.
 */
export const VARIANT_SIZES = { thumb: 400, preview: 1280 } as const;
export type Variant = keyof typeof VARIANT_SIZES;
export const VARIANTS = Object.keys(VARIANT_SIZES) as Variant[];
/** Bump when the encoding changes so cached files and browser ETags are invalidated. */
export const VARIANT_VERSION = 1;
export const VARIANT_MIME = 'image/webp';

/** Raster formats sharp decodes safely. SVG is excluded (already small, and rasterizing untrusted SVG isn't worth it). */
const RASTER = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/tiff', 'image/heic', 'image/heif']);

export const isVariantSource = (mimeType: string, hasFfmpeg: boolean) => RASTER.has(mimeType) || (hasFfmpeg && mimeType.startsWith('video/'));

/** Pixel limit for decoding (≈ 16k × 16k) so a hostile upload can't exhaust memory. */
const LIMIT_INPUT_PIXELS = 268_402_689;

function resize(input: string | Buffer, size: number) {
  return sharp(input, { limitInputPixels: LIMIT_INPUT_PIXELS })
    .rotate() // honour EXIF orientation
    .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: size <= VARIANT_SIZES.thumb ? 72 : 80, effort: 4 })
    .toBuffer();
}

/** At most this many ffmpeg processes at once (a gallery of old videos would otherwise fork one per tile). */
const FFMPEG_CONCURRENCY = 2;
let ffmpegActive = 0;
const ffmpegQueue: (() => void)[] = [];

async function withFfmpegSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (ffmpegActive >= FFMPEG_CONCURRENCY) await new Promise<void>((r) => ffmpegQueue.push(r));
  ffmpegActive++;
  try {
    return await fn();
  } finally {
    ffmpegActive--;
    ffmpegQueue.shift()?.();
  }
}

/** First representative frame of a video as PNG (ffmpeg's `thumbnail` filter skips black intro frames). */
function videoFrame(ffmpeg: string, src: string, timeoutMs = 60_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-i', src, '-vf', 'thumbnail=60', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'];
    const p = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.stderr.on('data', (d: Buffer) => (err += d.toString()).length > 4000 && (err = err.slice(-4000)));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      const png = Buffer.concat(out);
      if (code === 0 && png.length) resolve(png);
      else reject(new Error(`ffmpeg exited ${code}: ${err.trim() || 'no frame'}`));
    });
  });
}

/** True when `ffmpeg -version` runs; video posters are disabled otherwise. */
export function probeFfmpeg(ffmpeg: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, ['-version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

/** Renders a variant of `src` to `dest` (atomically, via a temp file). */
export async function renderVariant(opts: { src: string; dest: string; mimeType: string; variant: Variant; ffmpeg: string | null }): Promise<void> {
  const size = VARIANT_SIZES[opts.variant];
  let input: string | Buffer = opts.src;
  if (opts.mimeType.startsWith('video/')) {
    if (!opts.ffmpeg) throw new Error('ffmpeg unavailable');
    input = await withFfmpegSlot(() => videoFrame(opts.ffmpeg!, opts.src));
  }
  const webp = await resize(input, size);
  const tmp = `${opts.dest}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, webp);
    await rename(tmp, opts.dest);
  } finally {
    await rm(tmp, { force: true });
  }
}
