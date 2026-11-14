import { Hono } from 'hono';
import type { AppContext } from '../context.js';
import { VARIANTS, type Variant } from '../core/variants.js';
import { AppError, badRequest } from '../errors.js';
import type { Env } from '../http.js';
import { serveFile } from './serveFile.js';

/**
 * GET /media/:id?exp=…&sig=…[&variant=thumb|preview][&download=1] — signed file download, no auth header needed so
 * it works in <img>/<video>/download links. Streams from disk with HTTP Range + ETag.
 *
 * `variant=thumb|preview` returns a downscaled WebP (a still frame for videos) for galleries.
 */
export function mediaRoutes(ctx: AppContext) {
  const app = new Hono<Env>();

  app.get('/media/:id', async (c) => {
    const id = c.req.param('id');
    const exp = c.req.query('exp');
    if (!ctx.store.verify(id, exp, c.req.query('sig'))) throw new AppError(403, 'invalid_signature', 'Link expired or invalid');
    const variant = c.req.query('variant');
    if (variant !== undefined && !VARIANTS.includes(variant as Variant)) throw badRequest(`variant must be one of: ${VARIANTS.join(', ')}`, 'validation_error');
    const file = await ctx.store.get(id);

    // Files never change once stored, so the browser may keep them for as long as the signed URL is valid.
    const maxAge = Math.max(0, Number(exp) - Math.floor(Date.now() / 1000));
    const cacheControl = `private, max-age=${maxAge}, immutable`;
    const disposition = c.req.query('download') ? 'attachment' : 'inline';

    if (!variant) return serveFile(c, await ctx.store.original(file), { cacheControl, disposition });

    const rendition = await ctx.store.variant(file, variant as Variant).catch((err: unknown) => {
      ctx.log.warn('media.variant_failed', { fileId: id, variant, error: err instanceof Error ? err.message : String(err) });
      return undefined;
    });
    if (rendition) return serveFile(c, rendition, { cacheControl, disposition });
    // No rendition: images fall back to the original so <img> still shows something (not cached, so a later request
    // can pick up the rendition); videos/other files have nothing image-like to return.
    if (file.mimeType.startsWith('image/')) return serveFile(c, await ctx.store.original(file), { cacheControl: 'private, no-cache', disposition });
    throw new AppError(404, 'variant_unavailable', `No ${variant} available for this file`);
  });

  return app;
}
