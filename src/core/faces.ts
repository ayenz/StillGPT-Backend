import { and, count, desc, eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { faces, files } from '../db/schema.js';
import { AppError, badRequest, conflict } from '../errors.js';
import { newId } from '../ids.js';
import type { MediaStore, StoredFile } from './storage.js';

export type FaceRow = typeof faces.$inferSelect;
/** A saved face with its reference image (and the optional front portrait). */
export interface Face extends FaceRow {
  file: StoredFile;
  portrait: StoredFile | null;
}

/** Head swap `combo` reference: both images scaled to this height, side by side. */
export const FACE_COMBO_HEIGHT = 1400;
export const FACE_COMBO_GAP = 24;

/** Most faces one user may save. */
export const MAX_FACES = 50;
export const FACE_NAME_MAX = 60;
/** Reference images a face may use. */
export const FACE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

const nameSchema = z.string().trim().min(1, 'name is required').max(FACE_NAME_MAX, `name must be at most ${FACE_NAME_MAX} characters`);

function validName(name: unknown): string {
  const r = nameSchema.safeParse(name);
  if (!r.success) throw badRequest(`name: ${r.error.issues[0]!.message}`, 'validation_error', { param: 'name' });
  return r.data;
}

/**
 * Saved identities for face swap (`POST /images/:fileId/face-swap`). A face is a name plus one of the user's images
 * (a portrait or a 3x3 sheet of the same person). Deleting a face keeps its file and every past result.
 */
export class FaceService {
  constructor(private readonly d: { db: DB; store: MediaStore }) {}

  /** The user's faces, newest first. */
  async list(userId: string): Promise<Face[]> {
    const rows = await this.d.db
      .select({ face: faces, file: files })
      .from(faces)
      .innerJoin(files, eq(files.id, faces.fileId))
      .where(eq(faces.userId, userId))
      .orderBy(desc(faces.createdAt), desc(faces.id));
    return this.withPortraits(rows);
  }

  /** One face of the user's; 404 `face_not_found` otherwise. */
  async get(id: string, userId: string): Promise<Face> {
    const rows = await this.d.db
      .select({ face: faces, file: files })
      .from(faces)
      .innerJoin(files, eq(files.id, faces.fileId))
      .where(and(eq(faces.id, id), eq(faces.userId, userId)))
      .limit(1);
    if (!rows.length) throw new AppError(404, 'face_not_found', 'Face not found');
    return (await this.withPortraits(rows))[0]!;
  }

  private async withPortraits(rows: { face: FaceRow; file: StoredFile }[]): Promise<Face[]> {
    const ids = rows.flatMap((r) => (r.face.portraitFileId ? [r.face.portraitFileId] : []));
    const portraits = ids.length ? await this.d.db.select().from(files).where(inArray(files.id, ids)) : [];
    const byId = new Map(portraits.map((f) => [f.id, f]));
    return rows.map((r) => ({ ...r.face, file: r.file, portrait: (r.face.portraitFileId && byId.get(r.face.portraitFileId)) || null }));
  }

  async create(userId: string, input: { name: unknown; fileId: unknown; portraitFileId?: unknown }): Promise<Face> {
    const name = validName(input.name);
    if (typeof input.fileId !== 'string' || !input.fileId) throw badRequest('file_id: file_id is required', 'validation_error', { param: 'file_id' });
    const file = await this.imageOf(input.fileId, userId);
    const portrait = await this.portraitOf(input.portraitFileId, userId);
    const [{ n } = { n: 0 }] = await this.d.db.select({ n: count() }).from(faces).where(eq(faces.userId, userId));
    if (n >= MAX_FACES) throw conflict(`You can save at most ${MAX_FACES} faces; delete one first`, 'face_limit_reached');
    const [row] = await this.d.db
      .insert(faces)
      .values({ id: newId('face'), userId, name, fileId: file.id, portraitFileId: portrait?.id ?? null })
      .returning();
    return { ...row!, file, portrait };
  }

  /** PATCH: `name` and/or `portrait_file_id` (null clears it). A new portrait drops the cached combo image. */
  async update(id: string, userId: string, input: { name?: unknown; portraitFileId?: unknown }): Promise<Face> {
    const face = await this.get(id, userId);
    const set: Partial<FaceRow> = {};
    if (input.name !== undefined) set.name = validName(input.name);
    let portrait = face.portrait;
    if (input.portraitFileId !== undefined) {
      portrait = await this.portraitOf(input.portraitFileId, userId);
      if ((portrait?.id ?? null) !== face.portraitFileId) {
        set.portraitFileId = portrait?.id ?? null;
        set.comboFileId = null;
      }
    }
    if (!Object.keys(set).length) return face;
    await this.d.db.update(faces).set(set).where(eq(faces.id, face.id));
    return { ...face, ...set, portrait };
  }

  async rename(id: string, userId: string, name: unknown): Promise<Face> {
    return this.update(id, userId, { name });
  }

  /**
   * The head swap `combo` reference of a face: portrait (left) + main image (right), both scaled to FACE_COMBO_HEIGHT,
   * FACE_COMBO_GAP white pixels between them; an internal upload cached on the face. null without a portrait.
   */
  async comboFileId(face: Pick<FaceRow, 'id' | 'userId' | 'fileId' | 'portraitFileId'>): Promise<string | null> {
    if (!face.portraitFileId) return null;
    const [row] = await this.d.db.select({ comboFileId: faces.comboFileId, portraitFileId: faces.portraitFileId, fileId: faces.fileId }).from(faces).where(eq(faces.id, face.id));
    // the face changed since it was loaded: build for what it is now
    if (row && (row.portraitFileId !== face.portraitFileId || row.fileId !== face.fileId)) return row.portraitFileId ? this.comboFileId({ ...face, ...row }) : null;
    if (row?.comboFileId) {
      const cached = await this.d.store.get(row.comboFileId, face.userId).catch(() => null);
      if (cached) return cached.id;
    }
    const [portrait, main] = await Promise.all([this.d.store.get(face.portraitFileId, face.userId), this.d.store.get(face.fileId, face.userId)]);
    const scaled = await Promise.all(
      [portrait, main].map(async (f) => {
        const { data, info } = await sharp(this.d.store.pathOf(f)).rotate().resize({ height: FACE_COMBO_HEIGHT }).flatten({ background: '#ffffff' }).png().toBuffer({ resolveWithObject: true });
        return { data, width: info.width };
      }),
    );
    const [l, r] = scaled as [{ data: Buffer; width: number }, { data: Buffer; width: number }];
    const bytes = await sharp({ create: { width: l.width + FACE_COMBO_GAP + r.width, height: FACE_COMBO_HEIGHT, channels: 3, background: '#ffffff' } })
      .composite([
        { input: l.data, left: 0, top: 0 },
        { input: r.data, left: l.width + FACE_COMBO_GAP, top: 0 },
      ])
      .jpeg({ quality: 92 })
      .toBuffer();
    const file = await this.d.store.save({ userId: face.userId, kind: 'upload', filename: 'face-combo.jpg', mimeType: 'image/jpeg', bytes });
    // only if the face still has these images (a concurrent PATCH wins; the file is then an unused upload)
    await this.d.db
      .update(faces)
      .set({ comboFileId: file.id })
      .where(and(eq(faces.id, face.id), eq(faces.fileId, face.fileId), eq(faces.portraitFileId, face.portraitFileId)));
    return file.id;
  }

  /** Removes the face only; its file and past face-swap results stay. */
  async remove(id: string, userId: string): Promise<void> {
    const deleted = await this.d.db
      .delete(faces)
      .where(and(eq(faces.id, id), eq(faces.userId, userId)))
      .returning({ id: faces.id });
    if (!deleted.length) throw new AppError(404, 'face_not_found', 'Face not found');
  }

  private async portraitOf(id: unknown, userId: string): Promise<StoredFile | null> {
    if (id === undefined || id === null) return null;
    if (typeof id !== 'string' || !id) throw badRequest('portrait_file_id: must be a file id or null', 'validation_error', { param: 'portrait_file_id' });
    return this.imageOf(id, userId, 'portrait_file_id');
  }

  /** A file of the user's that is a png/jpeg/webp image. */
  private async imageOf(fileId: string, userId: string, param = 'file_id'): Promise<StoredFile> {
    const file = await this.d.store.get(fileId, userId).catch(() => {
      throw new AppError(404, 'file_not_found', `File ${fileId} not found`);
    });
    if (!(FACE_MIME_TYPES as readonly string[]).includes(file.mimeType))
      throw badRequest(`File ${fileId} must be a PNG, JPEG or WebP image (got ${file.mimeType})`, 'validation_error', { param });
    return file;
  }
}
