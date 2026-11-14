import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { Context } from 'hono';
import type { ServableFile } from '../core/storage.js';

export interface ServeOptions {
  /** `attachment` forces a download. Default `inline`. */
  disposition?: 'inline' | 'attachment';
  /** Cache-Control value. Default: private, not cached. */
  cacheControl?: string;
}

const stream = (path: string, start?: number, end?: number) =>
  Readable.toWeb(createReadStream(path, start === undefined ? {} : { start, end })) as unknown as ReadableStream<Uint8Array>;

/**
 * Streams a file from disk (never buffers it whole) with HTTP Range support — required for <video> seeking,
 * especially on Safari/iOS — and ETag/If-None-Match revalidation (304).
 */
export function serveFile(c: Context, file: ServableFile, opts: ServeOptions = {}): Response {
  const headers: Record<string, string> = {
    'Content-Type': file.mimeType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': opts.cacheControl ?? 'private, no-cache',
    ETag: file.etag,
    'Content-Disposition': `${opts.disposition ?? 'inline'}; filename="${encodeURIComponent(file.filename)}"`,
  };

  const inm = c.req.header('if-none-match');
  if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === file.etag)) {
    return c.body(null, 304, { ETag: headers.ETag!, 'Cache-Control': headers['Cache-Control']! });
  }

  const size = file.size;
  const range = c.req.header('range')?.match(/^bytes=(\d*)-(\d*)$/);
  const ifRange = c.req.header('if-range');
  if (range && (range[1] || range[2]) && (!ifRange || ifRange === file.etag)) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end) return c.body(null, 416, { 'Content-Range': `bytes */${size}` });
    return c.body(stream(file.path, start, end), 206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) });
  }
  return c.body(stream(file.path), 200, { ...headers, 'Content-Length': String(size) });
}
