import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { Face } from '../../core/faces.js';
import { imageBatchJson, MAX_FACE_SWAP_BATCH } from '../../core/media.js';
import type { Env } from '../../http.js';
import { body, fileView } from './util.js';

const faceSwapBody = z.object({
  face_id: z.string().min(1),
  /** 1–4 parallel results (default 1). */
  n: z.number().int().min(1).max(MAX_FACE_SWAP_BATCH).optional(),
  callback_url: z.string().optional(),
});

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
    const b = await body(c, faceSwapBody);
    const userId = c.get('user').id;
    const face = await ctx.faces.get(b.face_id, userId);
    const batch = await ctx.media.createFaceSwapBatch({
      userId,
      targetFileId: c.req.param('fileId'),
      face: { id: face.id, name: face.name, fileId: face.fileId },
      n: b.n,
      callbackUrl: b.callback_url,
    });
    return c.json(imageBatchJson(batch), 202);
  });

  return app;
}
