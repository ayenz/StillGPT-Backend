import { Hono } from 'hono';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';
import type { Env } from '../http.js';

/**
 * GET /media/:id?exp=…&sig=… — signed file download, no auth header needed so it works in
 * <img>/<video>/download links. Supports HTTP Range (required for <video> seeking on Safari/iOS).
 */
export function mediaRoutes(ctx: AppContext) {
  const app = new Hono<Env>();

  app.get('/media/:id', async (c) => {
    const id = c.req.param('id');
    if (!ctx.store.verify(id, c.req.query('exp'), c.req.query('sig'))) throw new AppError(403, 'invalid_signature', 'Link expired or invalid');
    const file = await ctx.store.get(id);
    const bytes = await ctx.store.read(file);
    const headers: Record<string, string> = {
      'Content-Type': file.mimeType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=86400',
      'Content-Disposition': `${c.req.query('download') ? 'attachment' : 'inline'}; filename="${encodeURIComponent(file.filename)}"`,
    };

    const range = c.req.header('range')?.match(/^bytes=(\d*)-(\d*)$/);
    if (range && (range[1] || range[2])) {
      const size = bytes.length;
      let start = range[1] ? Number(range[1]) : size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      start = Math.max(0, start);
      end = Math.min(end, size - 1);
      if (start > end) return c.body(null, 416, { 'Content-Range': `bytes */${size}` });
      return c.body(new Uint8Array(bytes.subarray(start, end + 1)), 206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) });
    }
    return c.body(new Uint8Array(bytes), 200, { ...headers, 'Content-Length': String(bytes.length) });
  });

  return app;
}
