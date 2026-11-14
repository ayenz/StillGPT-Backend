import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { IMAGE_SIZES, type ImageRequest, isTerminal, jobTopic, type MediaJobEvent, mediaJobJson, type VideoRequest } from '../../core/media.js';
import { WEBHOOK_EVENTS } from '../../core/webhooks.js';
import { badRequest } from '../../errors.js';
import type { Env } from '../../http.js';
import { FOLAX_PROMPT_MAX, FOLAX_RATIOS } from '../../providers/folax.js';
import { assertUploadSize, body, fileView, formFiles, limitParam, type SseEvent, saveUpload, sse } from './util.js';

/** Media bodies are validated by MediaService; here we only map snake_case → the service request. */
const imageBody = z.object({
  prompt: z.unknown(),
  size: z.unknown().optional(),
  enhance: z.unknown().optional(),
  input_file_ids: z.unknown().optional(),
  provider: z.unknown().optional(),
  async: z.boolean().optional(),
  callback_url: z.unknown().optional(),
});

const videoBody = z.object({
  prompt: z.unknown(),
  seconds: z.unknown().optional(),
  resolution: z.unknown().optional(),
  ratio: z.unknown().optional(),
  audio: z.unknown().optional(),
  first_frame_file_id: z.unknown().optional(),
  last_frame_file_id: z.unknown().optional(),
  reference_file_ids: z.unknown().optional(),
  enhance: z.unknown().optional(),
  callback_url: z.unknown().optional(),
});

const enhanceBody = z.object({
  prompt: z.string(),
  kind: z.enum(['image', 'video']).optional(),
  purpose: z.string().max(200).optional(),
  style: z.string().max(200).optional(),
  model: z.string().min(1).optional(),
});

/** POST /files, GET /files/:id */
export function fileRoutes(ctx: AppContext) {
  const app = new Hono<Env>();

  app.post('/files', async (c) => {
    assertUploadSize(c);
    const form = await c.req.parseBody({ all: true }).catch(() => {
      throw badRequest('Expected multipart/form-data with a `file` field', 'invalid_multipart');
    });
    const [file] = formFiles(form, 'file');
    if (!file) throw badRequest('Missing `file` field', 'validation_error');
    const saved = await saveUpload(ctx.store, c.get('user').id, file);
    return c.json(fileView(saved, ctx.store), 201);
  });

  app.get('/files/:id', async (c) => c.json(fileView(await ctx.store.get(c.req.param('id'), c.get('user').id), ctx.store)));

  return app;
}

/** /images, /videos, /jobs */
export function mediaJobRoutes(ctx: AppContext) {
  const app = new Hono<Env>();

  app.post('/images', async (c) => {
    const b = await body(c, imageBody);
    const req = {
      userId: c.get('user').id,
      prompt: b.prompt,
      size: b.size,
      enhance: b.enhance,
      inputFileIds: b.input_file_ids,
      provider: b.provider,
      callbackUrl: b.callback_url,
    } as ImageRequest;
    if (b.async) return c.json(mediaJobJson(await ctx.media.createImageJob(req)), 202);
    return c.json(mediaJobJson(await ctx.media.generateImage(req)));
  });

  app.post('/videos', async (c) => {
    const b = await body(c, videoBody);
    const req = {
      userId: c.get('user').id,
      prompt: b.prompt,
      seconds: b.seconds,
      resolution: b.resolution,
      ratio: b.ratio,
      audio: b.audio,
      firstFrameFileId: b.first_frame_file_id,
      lastFrameFileId: b.last_frame_file_id,
      referenceFileIds: b.reference_file_ids,
      enhance: b.enhance,
      callbackUrl: b.callback_url,
    } as VideoRequest;
    return c.json(mediaJobJson(await ctx.media.createVideoJob(req)), 202);
  });

  app.get('/jobs', async (c) => {
    const kind = c.req.query('kind') || undefined;
    if (kind !== undefined && kind !== 'image' && kind !== 'video') throw badRequest('kind must be image or video', 'validation_error');
    const data = await ctx.media.listJobs(c.get('user').id, { kind, limit: limitParam(c.req.query('limit'), 20, 100) });
    return c.json({ data: data.map(mediaJobJson) });
  });

  app.get('/jobs/:id', async (c) => c.json(mediaJobJson(await ctx.media.getJob(c.req.param('id'), c.get('user').id))));

  app.get('/jobs/:id/events', async (c) => {
    const id = c.req.param('id');
    const userId = c.get('user').id;
    await ctx.media.getJob(id, userId); // 404 before switching to SSE
    return sse(c, (signal) => jobEvents(ctx, id, userId, signal));
  });

  return app;
}

/** Snapshot first, then bus events until the job is terminal. Subscribes before the snapshot so nothing slips through. */
async function* jobEvents(ctx: AppContext, id: string, userId: string, signal: AbortSignal): AsyncGenerator<SseEvent> {
  const queue: MediaJobEvent[] = [];
  let wake: (() => void) | undefined;
  const unsubscribe = ctx.bus.subscribe<MediaJobEvent>(jobTopic(id), (e) => {
    queue.push(e);
    wake?.();
  });
  const onAbort = () => wake?.();
  signal.addEventListener('abort', onAbort, { once: true });
  let seq = 0;
  try {
    const job = await ctx.media.getJob(id, userId);
    yield { event: 'job', data: mediaJobJson(job), id: ++seq };
    if (isTerminal(job.status)) return;
    while (!signal.aborted) {
      if (!queue.length) await new Promise<void>((r) => (wake = r));
      wake = undefined;
      while (queue.length) {
        const e = queue.shift()!;
        if (e.type === 'progress') {
          yield { event: 'progress', data: { id: e.id, status: e.status, progress: e.progress }, id: ++seq };
          continue;
        }
        yield { event: e.type, data: mediaJobJson(e.job), id: ++seq };
        return;
      }
    }
  } finally {
    unsubscribe();
    signal.removeEventListener('abort', onAbort);
  }
}

/** `image_providers` section of GET /models. */
export function imageProviders(ctx: AppContext) {
  return {
    image_providers: [
      { id: 'qoder', available: true, edits: true, images_per_call: 1, sizes: IMAGE_SIZES },
      { id: 'folax', available: !!ctx.folax, edits: false, images_per_call: 2, ratios: FOLAX_RATIOS, prompt_max: FOLAX_PROMPT_MAX },
    ],
    default_image_provider: ctx.config.IMAGE_PROVIDER_DEFAULT,
  };
}

/** POST /prompts/enhance — the PWA's "✨ Enhance" button. */
export function promptRoutes(ctx: AppContext) {
  const app = new Hono<Env>();

  app.post('/prompts/enhance', async (c) => {
    const b = await body(c, enhanceBody);
    const userId = c.get('user').id;
    await ctx.usage.assertWithinLimit(userId);
    return c.json(await ctx.enhancer.enhance({ userId, ...b }));
  });

  return app;
}

/** /webhooks */
export function webhookRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  const view = (w: { id: string; url: string; events: string[]; createdAt: Date }) => ({ id: w.id, url: w.url, events: w.events, created_at: w.createdAt.toISOString() });

  app.get('/webhooks', async (c) => c.json({ data: (await ctx.webhooks.list(c.get('user').id)).map(view), available_events: WEBHOOK_EVENTS }));

  app.post('/webhooks', async (c) => {
    const b = await body(c, z.object({ url: z.string().min(1), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1) }));
    const hook = await ctx.webhooks.create(c.get('user').id, b);
    return c.json({ ...view(hook), secret: hook.secret }, 201);
  });

  app.delete('/webhooks/:id', async (c) => {
    await ctx.webhooks.remove(c.get('user').id, c.req.param('id'));
    return c.body(null, 204);
  });

  app.post('/webhooks/:id/test', async (c) => c.json(await ctx.webhooks.sendTest(c.get('user').id, c.req.param('id'))));

  return app;
}
