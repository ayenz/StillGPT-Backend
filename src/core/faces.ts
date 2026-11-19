import { and, count, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { faces, files } from '../db/schema.js';
import { AppError, badRequest, conflict } from '../errors.js';
import { newId } from '../ids.js';
import type { MediaStore, StoredFile } from './storage.js';

export type FaceRow = typeof faces.$inferSelect;
/** A saved face with its reference image. */
export interface Face extends FaceRow {
  file: StoredFile;
}

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
    return rows.map((r) => ({ ...r.face, file: r.file }));
  }

  /** One face of the user's; 404 `face_not_found` otherwise. */
  async get(id: string, userId: string): Promise<Face> {
    const [row] = await this.d.db
      .select({ face: faces, file: files })
      .from(faces)
      .innerJoin(files, eq(files.id, faces.fileId))
      .where(and(eq(faces.id, id), eq(faces.userId, userId)))
      .limit(1);
    if (!row) throw new AppError(404, 'face_not_found', 'Face not found');
    return { ...row.face, file: row.file };
  }

  async create(userId: string, input: { name: unknown; fileId: unknown }): Promise<Face> {
    const name = validName(input.name);
    if (typeof input.fileId !== 'string' || !input.fileId) throw badRequest('file_id: file_id is required', 'validation_error', { param: 'file_id' });
    const file = await this.imageOf(input.fileId, userId);
    const [{ n } = { n: 0 }] = await this.d.db.select({ n: count() }).from(faces).where(eq(faces.userId, userId));
    if (n >= MAX_FACES) throw conflict(`You can save at most ${MAX_FACES} faces; delete one first`, 'face_limit_reached');
    const [row] = await this.d.db.insert(faces).values({ id: newId('face'), userId, name, fileId: file.id }).returning();
    return { ...row!, file };
  }

  async rename(id: string, userId: string, name: unknown): Promise<Face> {
    const valid = validName(name);
    const face = await this.get(id, userId);
    await this.d.db.update(faces).set({ name: valid }).where(eq(faces.id, face.id));
    return { ...face, name: valid };
  }

  /** Removes the face only; its file and past face-swap results stay. */
  async remove(id: string, userId: string): Promise<void> {
    const deleted = await this.d.db
      .delete(faces)
      .where(and(eq(faces.id, id), eq(faces.userId, userId)))
      .returning({ id: faces.id });
    if (!deleted.length) throw new AppError(404, 'face_not_found', 'Face not found');
  }

  /** A file of the user's that is a png/jpeg/webp image. */
  private async imageOf(fileId: string, userId: string): Promise<StoredFile> {
    const file = await this.d.store.get(fileId, userId).catch(() => {
      throw new AppError(404, 'file_not_found', `File ${fileId} not found`);
    });
    if (!(FACE_MIME_TYPES as readonly string[]).includes(file.mimeType))
      throw badRequest(`File ${fileId} must be a PNG, JPEG or WebP image (got ${file.mimeType})`, 'validation_error', { param: 'file_id' });
    return file;
  }
}
