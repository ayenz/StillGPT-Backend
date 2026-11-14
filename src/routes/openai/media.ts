import { type Context, Hono } from 'hono';
import type { ImageProvider } from '../../config.js';
import type { AppContext } from '../../context.js';
import { IMAGE_SIZES, type ImageSize, type MediaJobView, VIDEO_RATIOS, type VideoRatio, type VideoRequest, type VideoResolution } from '../../core/media.js';
import { FOLAX_IMAGE_MODEL, IMAGE_MODEL, VIDEO_MODEL } from '../../core/models.js';
import { AppError, badRequest, notFound } from '../../errors.js';
import { type Env, jsonBody, requireUser } from '../../http.js';
import { assertUploadSize, formFiles, saveUpload } from '../native/util.js';
import { serveFile } from '../serveFile.js';

const MAX_N = 4;
const MAX_EDIT_IMAGES = 3;

/**
 * OpenAI-style media endpoints, mounted at /v1 by the OpenAI router:
 *   POST /images/generations, POST /images/edits      (synchronous, ~30 s per Qoder image, ~10 s per Folax call)
 *   POST /videos, GET /videos, GET /videos/:id, GET /videos/:id/content, DELETE /videos/:id
 */
export function openaiMediaRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  // Path-scoped so mounting this router at /v1 does not put auth on unrelated routes.
  for (const p of ['/images/*', '/videos', '/videos/*']) app.use(p, requireUser(ctx));

  app.post('/images/generations', async (c) => {
    const b = await jsonBody<Record<string, unknown>>(c);
    return c.json(await generateImages(ctx, c, { model: b.model, prompt: b.prompt, n: b.n, size: b.size, responseFormat: b.response_format, inputFileIds: [] }));
  });

  app.post('/images/edits', async (c) => {
    assertUploadSize(c, 3 * 20 * 1024 * 1024);
    const form = await multipart(c);
    const images = formFiles(form, 'image');
    if (!images.length) throw badRequest('At least one `image` is required', 'missing_image', { param: 'image' });
    if (images.length > MAX_EDIT_IMAGES) throw badRequest(`At most ${MAX_EDIT_IMAGES} images are supported`, 'too_many_images', { param: 'image' });
    const userId = c.get('user').id;
    const saved = await Promise.all(images.map((f) => saveUpload(ctx.store, userId, f)));
    return c.json(
      await generateImages(ctx, c, {
        model: form.model,
        prompt: form.prompt,
        n: form.n === undefined ? undefined : Number(form.n),
        size: form.size,
        responseFormat: form.response_format,
        inputFileIds: saved.map((f) => f.id),
      }),
    );
  });

  app.post('/videos', async (c) => {
    const isMultipart = (c.req.header('content-type') ?? '').includes('multipart/form-data');
    const fields = isMultipart ? await multipart(c) : await jsonBody<Record<string, unknown>>(c);
    const userId = c.get('user').id;
    let firstFrameFileId: string | undefined;
    const [reference] = formFiles(fields, 'input_reference');
    if (reference) firstFrameFileId = (await saveUpload(ctx.store, userId, reference)).id;
    const req = { userId, ...videoParams(fields), ...(firstFrameFileId ? { firstFrameFileId } : {}) } as VideoRequest;
    return c.json(videoObject(await ctx.media.createVideoJob(req)));
  });

  app.get('/videos', async (c) => {
    const limit = Number(c.req.query('limit') ?? 20);
    const jobs = await ctx.media.listJobs(c.get('user').id, { kind: 'video', limit: Number.isFinite(limit) ? limit : 20 });
    const data = jobs.map(videoObject);
    return c.json({ object: 'list', data, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null, has_more: false });
  });

  app.get('/videos/:id', async (c) => c.json(videoObject(await videoJob(ctx, c))));

  app.get('/videos/:id/content', async (c) => {
    const variant = c.req.query('variant') ?? 'video';
    if (variant !== 'video') throw notFound(`Variant '${variant}'`);
    const job = await videoJob(ctx, c);
    const file = await ctx.media.outputFile(job.id, c.get('user').id);
    return serveFile(c, await ctx.store.original(file), { cacheControl: 'private, no-cache' });
  });

  app.delete('/videos/:id', async (c) => {
    await videoJob(ctx, c);
    throw new AppError(501, 'not_supported', 'Deleting videos is not supported');
  });

  return app;
}

// ── images ─────────────────────────────────────────────────────────────────

interface ImageCall {
  model: unknown;
  prompt: unknown;
  n: unknown;
  size: unknown;
  responseFormat: unknown;
  inputFileIds: string[];
}

/**
 * `qoder-image` → Qoder ImageGen, `folax-image` → Folax; OpenAI model names (or none) use the default provider,
 * so stock clients work unchanged.
 */
function imageProviderOf(model: unknown): ImageProvider | undefined {
  if (model === IMAGE_MODEL) return 'qoder';
  if (model === FOLAX_IMAGE_MODEL) return 'folax';
  if (model === undefined || model === null || /^(dall-e|gpt-image)/.test(String(model))) return undefined;
  throw badRequest(`Unknown image model '${String(model)}'; use '${IMAGE_MODEL}' or '${FOLAX_IMAGE_MODEL}'`, 'model_not_found', { param: 'model' });
}

/** Sequential jobs until n images are collected (Qoder yields 1 per job, Folax 2). */
async function generateImages(ctx: AppContext, c: Context<Env>, call: ImageCall) {
  const provider = imageProviderOf(call.model);
  const n = call.n === undefined || call.n === null ? 1 : Number(call.n);
  if (!Number.isInteger(n) || n < 1 || n > MAX_N) throw badRequest(`n must be an integer between 1 and ${MAX_N}`, 'invalid_n', { param: 'n' });
  const format = call.responseFormat ?? 'url';
  if (format !== 'url' && format !== 'b64_json') throw badRequest("response_format must be 'url' or 'b64_json'", 'invalid_response_format', { param: 'response_format' });
  const size = nearestImageSize(call.size);
  const userId = c.get('user').id;

  const data: ({ url: string } | { b64_json: string })[] = [];
  let credits = 0;
  while (data.length < n) {
    const job = await ctx.media.generateImage({ userId, prompt: call.prompt as string, size, inputFileIds: call.inputFileIds, provider });
    if (job.status !== 'completed' || !job.outputs.length) throw new AppError(502, job.error?.code ?? 'generation_failed', job.error?.message ?? 'Image generation failed');
    credits += job.credits ?? 0;
    for (const out of job.outputs.slice(0, n - data.length)) {
      if (format === 'url') data.push({ url: out.url });
      else data.push({ b64_json: (await ctx.store.read(await ctx.store.get(out.id, userId))).toString('base64') });
    }
  }
  c.header('X-StillGPT-Credits', String(Math.round(credits * 10000) / 10000));
  return { created: Math.floor(Date.now() / 1000), data };
}

const parseSize = (v: unknown): [number, number] | null => {
  const m = typeof v === 'string' ? /^(\d+)x(\d+)$/.exec(v.trim()) : null;
  return m ? [Number(m[1]), Number(m[2])] : null;
};

/** Exact match, else the allowed size with the closest aspect ratio (then closest area). `auto`/absent → 1024x1024. */
export function nearestImageSize(size: unknown): ImageSize {
  if (size === undefined || size === null || size === 'auto') return '1024x1024';
  if ((IMAGE_SIZES as readonly unknown[]).includes(size)) return size as ImageSize;
  const wh = parseSize(size);
  if (!wh || !wh[0] || !wh[1]) throw badRequest(`Invalid size '${String(size)}' (expected WIDTHxHEIGHT)`, 'invalid_size', { param: 'size' });
  const score = (s: ImageSize) => {
    const [w, h] = parseSize(s)!;
    return Math.abs(Math.log(w / h) - Math.log(wh[0] / wh[1])) * 10 + Math.abs(Math.log((w * h) / (wh[0] * wh[1])));
  };
  return [...IMAGE_SIZES].sort((a, b) => score(a) - score(b))[0]!;
}

// ── videos ─────────────────────────────────────────────────────────────────

const RATIO_VALUES = VIDEO_RATIOS.filter((r) => r !== 'adaptive').map((r) => {
  const [a, b] = r.split(':').map(Number);
  return { ratio: r, value: a! / b! };
});

/** OpenAI `size` ('1280x720') → our ratio + resolution (resolution from the short side). */
export function videoSizeToParams(size: unknown): { ratio: VideoRatio; resolution: VideoResolution } | null {
  const wh = parseSize(size);
  if (!wh || !wh[0] || !wh[1]) return null;
  const value = wh[0] / wh[1];
  const ratio = [...RATIO_VALUES].sort((a, b) => Math.abs(Math.log(a.value / value)) - Math.abs(Math.log(b.value / value)))[0]!.ratio;
  const short = Math.min(wh[0], wh[1]);
  return { ratio, resolution: short <= 480 ? '480P' : short <= 720 ? '720P' : '1080P' };
}

/** Our ratio + resolution → a WIDTHxHEIGHT string for the video object. */
export function paramsToVideoSize(ratio: string, resolution: string): string {
  const p = Number.parseInt(resolution, 10) || 1080;
  const [a, b] = (ratio === 'adaptive' ? '16:9' : ratio).split(':').map(Number) as [number, number];
  const even = (n: number) => Math.round(n / 2) * 2;
  return a >= b ? `${even((p * a) / b)}x${p}` : `${p}x${even((p * b) / a)}`;
}

function videoParams(f: Record<string, unknown>): Omit<VideoRequest, 'userId'> {
  if (f.model !== undefined && f.model !== VIDEO_MODEL && !String(f.model).startsWith('sora')) {
    throw badRequest(`Unknown video model '${String(f.model)}'; use '${VIDEO_MODEL}'`, 'model_not_found', { param: 'model' });
  }
  if (f.size !== undefined && !videoSizeToParams(f.size)) throw badRequest(`Invalid size '${String(f.size)}' (expected WIDTHxHEIGHT)`, 'invalid_size', { param: 'size' });
  const fromSize = f.size === undefined ? null : videoSizeToParams(f.size);
  const seconds = f.seconds === undefined || f.seconds === '' ? undefined : Number(f.seconds);
  const audio = f.audio === undefined ? undefined : f.audio === true || f.audio === 'true' ? true : f.audio === false || f.audio === 'false' ? false : (f.audio as boolean);
  return {
    prompt: f.prompt as string,
    seconds,
    resolution: (f.resolution as VideoResolution | undefined) ?? fromSize?.resolution,
    ratio: (f.ratio as VideoRatio | undefined) ?? fromSize?.ratio,
    audio,
    callbackUrl: f.callback_url as string | undefined,
  };
}

async function videoJob(ctx: AppContext, c: Context<Env>): Promise<MediaJobView> {
  const job = await ctx.media.getJob(c.req.param('id')!, c.get('user').id);
  if (job.kind !== 'video') throw notFound('Video');
  return job;
}

const unix = (iso: string | null) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);

/** OpenAI Videos API object. */
export function videoObject(job: MediaJobView) {
  const r = job.request;
  return {
    id: job.id,
    object: 'video' as const,
    model: VIDEO_MODEL,
    status: job.status,
    progress: job.progress,
    created_at: unix(job.created_at)!,
    completed_at: unix(job.completed_at),
    expires_at: null,
    seconds: String(r.seconds),
    size: paramsToVideoSize(String(r.ratio), String(r.resolution)),
    remixed_from_video_id: null,
    error: job.error ? { code: job.error.code, message: job.error.message } : null,
  };
}

// ── plumbing ───────────────────────────────────────────────────────────────

async function multipart(c: Context<Env>): Promise<Record<string, unknown>> {
  return (await c.req.parseBody({ all: true }).catch(() => {
    throw badRequest('Expected multipart/form-data', 'invalid_multipart');
  })) as Record<string, unknown>;
}
