import { createHmac } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { files } from '../db/schema.js';
import { notFound } from '../errors.js';
import { newId, safeEqual, sha256 } from '../ids.js';
import { type Artifact, artifactKind } from './events.js';
import { isVariantSource, renderVariant, VARIANT_MIME, VARIANT_VERSION, VARIANTS, type Variant } from './variants.js';

export type StoredFile = typeof files.$inferSelect;

export interface SaveInput {
  userId: string;
  kind: 'upload' | 'artifact';
  filename: string;
  mimeType: string;
  bytes: Buffer;
  conversationId?: string | null;
  jobId?: string | null;
  qoderFileId?: string | null;
}

/** A file (or rendered variant) ready to be served from disk. */
export interface ServableFile {
  path: string;
  size: number;
  mimeType: string;
  filename: string;
  etag: string;
}

/** Signed URLs for a file: the original plus gallery-sized renditions (null when the type has none). */
export interface MediaUrls {
  url: string;
  thumbnailUrl: string | null;
  previewUrl: string | null;
}

/** Signed URL expiries are rounded up to this so a file's URL stays identical (and browser-cacheable) for a day. */
const EXP_BUCKET_SEC = 24 * 3600;

/** `trash`: an admin URL that also serves files whose job is in the trash. */
export type UrlScope = 'trash';

/** Local disk media store + HMAC-signed URLs (`/media/:id?exp=…&sig=…[&variant=thumb|preview]`). */
export class MediaStore {
  private readonly dir: string;
  /** In-flight variant renders, so concurrent requests for the same thumbnail share one job. */
  private readonly rendering = new Map<string, Promise<void>>();

  constructor(
    private readonly db: DB,
    dir: string,
    private readonly publicBaseUrl: string,
    private readonly secret: string,
    private readonly ttlSec: number,
    /** ffmpeg binary for video posters; null disables them. */
    private readonly ffmpeg: string | null = null,
  ) {
    this.dir = resolve(dir);
  }

  async save(input: SaveInput): Promise<StoredFile> {
    const id = newId('file');
    const now = new Date();
    const rel = join(String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), id);
    await mkdir(join(this.dir, rel, '..'), { recursive: true });
    await writeFile(join(this.dir, rel), input.bytes);
    const [row] = await this.db
      .insert(files)
      .values({
        id,
        userId: input.userId,
        kind: input.kind,
        filename: sanitizeFilename(input.filename),
        mimeType: inferMimeType(input.filename, input.bytes, input.mimeType),
        size: input.bytes.length,
        sha256: sha256(input.bytes),
        storagePath: rel,
        qoderFileId: input.qoderFileId ?? null,
        conversationId: input.conversationId ?? null,
        jobId: input.jobId ?? null,
      })
      .returning();
    // Pre-render gallery variants in the background so the first gallery load is already fast.
    if (this.hasVariants(row!.mimeType)) void Promise.all(VARIANTS.map((v) => this.variant(row!, v).catch(() => null)));
    return row!;
  }

  /** A stored file; files in the trash count as missing unless `includeDeleted`. */
  async get(id: string, userId?: string, opts: { includeDeleted?: boolean } = {}): Promise<StoredFile> {
    const where = userId ? and(eq(files.id, id), eq(files.userId, userId)) : eq(files.id, id);
    const [row] = await this.db.select().from(files).where(where).limit(1);
    if (!row || (row.deletedAt && !opts.includeDeleted)) throw notFound('File');
    return row;
  }

  /** Delete a file for good: the original, its cached variants and the row. Returns the bytes freed on disk. */
  async remove(file: StoredFile): Promise<number> {
    const path = this.pathOf(file);
    const name = basename(path);
    let freed = 0;
    const siblings = await readdir(dirname(path)).catch(() => [] as string[]);
    for (const entry of siblings) {
      if (entry !== name && !entry.startsWith(`${name}.`)) continue;
      const p = join(dirname(path), entry);
      freed += (await stat(p).catch(() => null))?.size ?? 0;
      await rm(p, { force: true });
    }
    await this.db.delete(files).where(eq(files.id, file.id));
    return freed;
  }

  read(file: StoredFile): Promise<Buffer> {
    return readFile(this.pathOf(file));
  }

  pathOf(file: StoredFile): string {
    return join(this.dir, file.storagePath);
  }

  /** The original file, for streaming. */
  async original(file: StoredFile): Promise<ServableFile> {
    const { size } = await stat(this.pathOf(file));
    return { path: this.pathOf(file), size, mimeType: file.mimeType, filename: file.filename, etag: `"${file.sha256}"` };
  }

  hasVariants(mimeType: string): boolean {
    return isVariantSource(mimeType, !!this.ffmpeg);
  }

  /**
   * A downscaled WebP rendition (video → still frame), rendered on first use and cached next to the original.
   * Returns null when this file type has no variants. Throws if rendering fails.
   */
  async variant(file: StoredFile, variant: Variant): Promise<ServableFile | null> {
    if (!this.hasVariants(file.mimeType)) return null;
    const path = `${this.pathOf(file)}.${variant}.v${VARIANT_VERSION}.webp`;
    let st = await stat(path).catch(() => null);
    if (!st) {
      let job = this.rendering.get(path);
      if (!job) {
        job = (async () => {
          // A video's thumb is cut from its preview still, so ffmpeg runs once per video.
          const fromPreview = file.mimeType.startsWith('video/') && variant !== 'preview';
          const src = fromPreview ? (await this.variant(file, 'preview'))!.path : this.pathOf(file);
          await renderVariant({ src, dest: path, mimeType: fromPreview ? VARIANT_MIME : file.mimeType, variant, ffmpeg: this.ffmpeg });
        })().finally(() => this.rendering.delete(path));
        this.rendering.set(path, job);
      }
      await job;
      st = await stat(path);
    }
    const base = file.filename.replace(/\.[^.]*$/, '') || 'file';
    return { path, size: st.size, mimeType: VARIANT_MIME, filename: `${base}.${variant}.webp`, etag: `"${file.sha256}-${variant}-v${VARIANT_VERSION}"` };
  }

  /** Original + thumbnail/preview URLs for a file id (thumbnail/preview null when the type has none). */
  urls(fileId: string, mimeType: string, scope?: UrlScope): MediaUrls {
    const url = this.signedUrl(fileId, this.ttlSec, scope);
    if (!this.hasVariants(mimeType)) return { url, thumbnailUrl: null, previewUrl: null };
    return { url, thumbnailUrl: `${url}&variant=thumb`, previewUrl: `${url}&variant=preview` };
  }

  async setQoderFileId(id: string, qoderFileId: string | null) {
    await this.db.update(files).set({ qoderFileId }).where(eq(files.id, id));
  }

  /** Cache what a vision model read from an image (used by prompt variations). */
  async setTraits(id: string, traits: Record<string, string>) {
    await this.db.update(files).set({ traits }).where(eq(files.id, id));
  }

  /**
   * Valid for at least `ttlSec`. The expiry is rounded up to the next day boundary so repeated listings return the
   * exact same URL and the browser cache actually hits (a fresh `exp` per request made every gallery load re-download).
   */
  signedUrl(fileId: string, ttlSec = this.ttlSec, scope?: UrlScope): string {
    const bucket = Math.max(1, Math.min(EXP_BUCKET_SEC, ttlSec));
    const exp = Math.ceil((Math.floor(Date.now() / 1000) + ttlSec) / bucket) * bucket;
    return `${this.publicBaseUrl.replace(/\/$/, '')}/media/${fileId}?exp=${exp}&sig=${this.sign(fileId, exp, scope)}${scope ? `&scope=${scope}` : ''}`;
  }

  verify(fileId: string, exp: string | undefined, sig: string | undefined, scope?: UrlScope): boolean {
    const expNum = Number(exp);
    if (!sig || !Number.isFinite(expNum) || expNum < Date.now() / 1000) return false;
    return safeEqual(sig, this.sign(fileId, expNum, scope));
  }

  /** `scope: 'trash'` signs URLs that still work while the file is in the trash (admin trash view only). */
  toArtifact(file: StoredFile, scope?: UrlScope): Artifact {
    return { id: file.id, name: file.filename, mimeType: file.mimeType, size: file.size, kind: artifactKind(file.mimeType), ...this.urls(file.id, file.mimeType, scope) };
  }

  private sign(fileId: string, exp: number, scope?: UrlScope) {
    return createHmac('sha256', this.secret).update(scope ? `${fileId}.${exp}.${scope}` : `${fileId}.${exp}`).digest('base64url');
  }
}

export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() || 'file';
  return base.replace(/[^\w.\- ()]+/g, '_').slice(0, 200) || 'file';
}

const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/unknown']);

const BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};

/**
 * Keep a specific MIME type as given; replace generic ones (Qoder sometimes delivers MP4s as
 * application/octet-stream, which breaks <video> on Safari) using magic bytes, then the file extension.
 */
export function inferMimeType(filename: string, bytes: Buffer, given?: string | null): string {
  const declared = (given ?? '').split(';')[0]!.trim().toLowerCase();
  if (!GENERIC_TYPES.has(declared)) return declared;
  const head = bytes.subarray(0, 12);
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (head.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (head.subarray(4, 8).toString('latin1') === 'ftyp') return /\.mov$/i.test(filename) ? 'video/quicktime' : 'video/mp4';
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return (ext && BY_EXTENSION[ext]) || 'application/octet-stream';
}
