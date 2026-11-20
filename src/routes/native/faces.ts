import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { Face } from '../../core/faces.js';
import { applyPatch, DEFAULT_FACE_SWAP_SETTINGS, FACE_SWAP_ENGINES, type FaceSwapSettings, faceSwapSettingsPatch } from '../../core/faceSwap.js';
import { imageBatchJson, MAX_FACE_SWAP_BATCH, mediaJobJson } from '../../core/media.js';
import { badRequest, forbidden } from '../../errors.js';
import type { Env } from '../../http.js';
import { body, fileView, parse } from './util.js';

const faceSwapBody = z.object({
  face_id: z.string().min(1),
  /** Default: the admin setting `default_engine`. */
  engine: z.enum(FACE_SWAP_ENGINES).optional(),
  /** 1–4 parallel results (default 1; always 1 for `swapper`). */
  n: z.number().int().min(1).max(MAX_FACE_SWAP_BATCH).optional(),
  callback_url: z.string().optional(),
  /** Admin only: settings patch for this batch (same shape as PUT /admin/face-swap/settings, nulls ignored). */
  settings_override: faceSwapSettingsPatch.optional(),
  /** Admin only: experiment label, listable via GET /admin/face-swap/jobs?tag=. */
  tag: z.string().optional(),
});

const FACE_SWAP_TAG = /^[A-Za-z0-9._:-]{1,64}$/;
const tagError = () => badRequest('tag must be 1-64 characters of A-Z a-z 0-9 . _ : -', 'validation_error', { param: 'tag' });

/** /faces (saved identities) and POST /images/:fileId/face-swap. */
export function faceRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  const view = (f: Face) => ({ id: f.id, name: f.name, file_id: f.fileId, file: fileView(f.file, ctx.store), created_at: f.createdAt.toISOString() });

  app.get('/faces', async (c) => c.json({ data: (await ctx.faces.list(c.get('user').id)).map(view) }));

  app.post('/faces', async (c) => {
    const b = await body(c, z.object({ name: z.unknown(), file_id: z.unknown() }));
    return c.json(view(await ctx.faces.create(c.get('user').id, { name: b.name, fileId: b.file_id })), 201);
  });

  app.patch('/faces/:id', async (c) => {
    const b = await body(c, z.object({ name: z.unknown() }));
    return c.json(view(await ctx.faces.rename(c.req.param('id'), c.get('user').id, b.name)));
  });

  app.delete('/faces/:id', async (c) => {
    await ctx.faces.remove(c.req.param('id'), c.get('user').id);
    return c.body(null, 204);
  });

  /** Always async: 202 with the image batch; follow it via /images/batches/:id(/events) or the gallery. */
  app.post('/images/:fileId/face-swap', async (c) => {
    const raw = await body(c, z.unknown());
    const user = c.get('user');
    // admin-only fields are refused before validation, so a non-admin never learns about the override's shape
    if (raw && typeof raw === 'object' && ('settings_override' in raw || 'tag' in raw) && user.role !== 'admin')
      throw forbidden('settings_override and tag are admin only');
    const b = parse(faceSwapBody, raw);
    if (b.tag !== undefined && !FACE_SWAP_TAG.test(b.tag)) throw tagError();
    const userId = user.id;
    const face = await ctx.faces.get(b.face_id, userId);
    const batch = await ctx.media.createFaceSwapBatch({
      userId,
      targetFileId: c.req.param('fileId'),
      face: { id: face.id, name: face.name, fileId: face.fileId },
      engine: b.engine,
      n: b.n,
      callbackUrl: b.callback_url,
      settingsOverride: b.settings_override,
      tag: b.tag,
    });
    return c.json(imageBatchJson(batch), 202);
  });

  /** What the face swap dialog offers: default engine, which engines can run now, max results. */
  app.get('/face-swap/config', async (c) =>
    c.json({ default_engine: ctx.faceSwapSettings.get().default_engine, engines: await ctx.faceSwapSettings.engines(), max_n: MAX_FACE_SWAP_BATCH }),
  );

  return app;
}

/** Admin: face swap settings and a synchronous swapper test. Mounted under /admin (requireAdmin). */
export function faceSwapAdminRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  const view = async (settings: FaceSwapSettings, fresh = false) => ({ settings, defaults: DEFAULT_FACE_SWAP_SETTINGS, sidecar: await ctx.faceSwapSettings.sidecar(fresh) });

  app.get('/admin/face-swap/settings', async (c) => c.json(await view(ctx.faceSwapSettings.get(), true)));

  /** Partial merge; `null` resets a field (or the whole `swapper` block) to its default. */
  app.put('/admin/face-swap/settings', async (c) => c.json(await view(await ctx.faceSwapSettings.update(await jsonOf(c)))));

  /** Experiment jobs of the admin with `request.face_swap.tag = tag`: newest first, all statuses, max 500. */
  app.get('/admin/face-swap/jobs', async (c) => {
    const tag = c.req.query('tag') ?? '';
    if (!FACE_SWAP_TAG.test(tag)) throw tagError();
    return c.json({ data: (await ctx.media.listFaceSwapJobsByTag(c.get('user').id, tag)).map(mediaJobJson) });
  });

  /** Runs the swapper on one of the admin's images + faces without creating a job; qoder engines are not supported. */
  app.post('/admin/face-swap/test', async (c) => {
    const b = await body(
      c,
      z
        .object({
          target_file_id: z.string().min(1),
          face_id: z.string().min(1),
          engine: z.enum(FACE_SWAP_ENGINES).optional(),
          settings_override: faceSwapSettingsPatch.optional(),
        })
        .strict(),
    );
    const engine = b.engine ?? 'swapper';
    if (engine !== 'swapper') throw badRequest(`The test runs only the swapper engine (got ${engine})`, 'test_engine_unsupported', { param: 'engine' });
    const userId = c.get('user').id;
    const face = await ctx.faces.get(b.face_id, userId);
    const settings = applyPatch(ctx.faceSwapSettings.get(), b.settings_override);
    const r = await ctx.media.testFaceSwap({ userId, targetFileId: b.target_file_id, faceFileId: face.fileId, options: settings.swapper });
    return c.json({ ...r, engine });
  });

  return app;
}

/** Raw JSON body (validation happens in the settings service, which reports per-field issues). */
async function jsonOf(c: Parameters<typeof body>[0]) {
  return body(c, z.unknown());
}
