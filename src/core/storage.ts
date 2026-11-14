import { createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { files } from '../db/schema.js';
import { notFound } from '../errors.js';
import { newId, safeEqual, sha256 } from '../ids.js';
import { type Artifact, artifactKind } from './events.js';

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

/** Local disk media store + HMAC-signed URLs (`/media/:id?exp=…&sig=…`). */
export class MediaStore {
  private readonly dir: string;

  constructor(
    private readonly db: DB,
    dir: string,
    private readonly publicBaseUrl: string,
    private readonly secret: string,
    private readonly ttlSec: number,
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
    return row!;
  }

  async get(id: string, userId?: string): Promise<StoredFile> {
    const where = userId ? and(eq(files.id, id), eq(files.userId, userId)) : eq(files.id, id);
    const [row] = await this.db.select().from(files).where(where).limit(1);
    if (!row) throw notFound('File');
    return row;
  }

  read(file: StoredFile): Promise<Buffer> {
    return readFile(join(this.dir, file.storagePath));
  }

  async setQoderFileId(id: string, qoderFileId: string) {
    await this.db.update(files).set({ qoderFileId }).where(eq(files.id, id));
  }

  signedUrl(fileId: string, ttlSec = this.ttlSec): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    return `${this.publicBaseUrl.replace(/\/$/, '')}/media/${fileId}?exp=${exp}&sig=${this.sign(fileId, exp)}`;
  }

  verify(fileId: string, exp: string | undefined, sig: string | undefined): boolean {
    const expNum = Number(exp);
    if (!sig || !Number.isFinite(expNum) || expNum < Date.now() / 1000) return false;
    return safeEqual(sig, this.sign(fileId, expNum));
  }

  toArtifact(file: StoredFile): Artifact {
    return { id: file.id, name: file.filename, mimeType: file.mimeType, size: file.size, kind: artifactKind(file.mimeType), url: this.signedUrl(file.id) };
  }

  private sign(fileId: string, exp: number) {
    return createHmac('sha256', this.secret).update(`${fileId}.${exp}`).digest('base64url');
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
