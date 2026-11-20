import { and, desc, eq, inArray, isNotNull, isNull, lt, notInArray, or, type SQL, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { conversations, faces, files, mediaJobs, messages, users } from '../db/schema.js';
import { AppError, notFound } from '../errors.js';
import type { Logger } from '../log.js';
import { isTerminal, type MediaJob, type MediaJobView, type MediaService } from './media.js';
import type { MediaStore, StoredFile } from './storage.js';

export type TrashedBy = 'user' | 'admin' | 'system';

export interface TrashResult {
  trashed: string[];
  skipped: { id: string; reason: 'not_found' | 'job_running' }[];
}

/** Counters of one purge (shared with the media housekeeping report). */
export interface PurgeCounts {
  jobsPurged: number;
  filesDeleted: number;
  /** Files kept because something live still uses them (another job, a chat message). */
  filesInUse: number;
  bytesFreed: number;
  errors: number;
}

export const emptyCounts = (): PurgeCounts => ({ jobsPurged: 0, filesDeleted: 0, filesInUse: 0, bytesFreed: 0, errors: 0 });

export interface TrashItem {
  job: MediaJobView;
  user: { id: string; email: string };
  deletedAt: string;
  deletedBy: TrashedBy | null;
  /** Earliest moment housekeeping deletes it for good (deleted_at + the grace period). */
  purgeAt: string;
  bytes: number;
}

/**
 * The gallery trash. Trashing a job hides it (and its output files: their URLs 404) right away; housekeeping deletes
 * it for good after the grace period, unless restored first. A file is only deleted from disk when nothing live
 * still uses it: another job (as output or input), a message in a chat that is not archived, or a saved face.
 */
export class MediaTrash {
  constructor(private readonly d: { db: DB; store: MediaStore; media: MediaService; log: Logger }) {}

  // ── trash & restore ───────────────────────────────────────────────────────

  /** Move finished jobs to the trash. `userId` limits it to that user's jobs (null = any user, for admins). */
  async trash(ids: string[], by: TrashedBy, userId: string | null): Promise<TrashResult> {
    const unique = [...new Set(ids)];
    if (!unique.length) return { trashed: [], skipped: [] };
    const rows = await this.d.db
      .select()
      .from(mediaJobs)
      .where(and(inArray(mediaJobs.id, unique), isNull(mediaJobs.deletedAt), userId ? eq(mediaJobs.userId, userId) : undefined));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const result: TrashResult = { trashed: [], skipped: [] };
    for (const id of unique) {
      const row = byId.get(id);
      if (!row) result.skipped.push({ id, reason: 'not_found' });
      else if (!isTerminal(row.status)) result.skipped.push({ id, reason: 'job_running' });
      else result.trashed.push(id);
    }
    if (result.trashed.length) {
      const now = new Date();
      await this.d.db.update(mediaJobs).set({ deletedAt: now, deletedBy: by }).where(inArray(mediaJobs.id, result.trashed));
      await this.hideFiles(result.trashed.flatMap((id) => byId.get(id)!.resultFileIds), now);
      this.d.log.info('trash.jobs_trashed', { count: result.trashed.length, by });
    }
    return result;
  }

  /** DELETE of a single job: 404 / 409 instead of a skipped entry. */
  async trashOne(id: string, by: TrashedBy, userId: string | null): Promise<void> {
    const r = await this.trash([id], by, userId);
    if (r.skipped[0]?.reason === 'not_found') throw notFound('Job');
    if (r.skipped[0]?.reason === 'job_running') throw new AppError(409, 'job_running', 'The job is still running; delete it once it finished');
  }

  /** All jobs of one of the user's batches. 409 (nothing trashed) while any of them still runs. */
  async trashBatch(batchId: string, userId: string): Promise<TrashResult> {
    const rows = await this.d.db
      .select({ id: mediaJobs.id, status: mediaJobs.status })
      .from(mediaJobs)
      .where(and(eq(mediaJobs.batchId, batchId), eq(mediaJobs.userId, userId), isNull(mediaJobs.deletedAt)));
    if (!rows.length) throw notFound('Batch');
    if (rows.some((r) => !isTerminal(r.status))) throw new AppError(409, 'job_running', 'Some images of this batch are still running; delete it once it finished');
    return this.trash(
      rows.map((r) => r.id),
      'user',
      userId,
    );
  }

  /** Trash every failed job of the user ("clear failed"). */
  async clearFailed(userId: string): Promise<TrashResult> {
    const rows = await this.d.db
      .select({ id: mediaJobs.id })
      .from(mediaJobs)
      .where(and(eq(mediaJobs.userId, userId), eq(mediaJobs.status, 'failed'), isNull(mediaJobs.deletedAt)));
    return this.trash(
      rows.map((r) => r.id),
      'user',
      userId,
    );
  }

  /** Back to the gallery. `userId` limits it to that user's jobs (null = any user, for admins). */
  async restore(ids: string[], userId: string | null): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    const rows = await this.d.db
      .update(mediaJobs)
      .set({ deletedAt: null, deletedBy: null })
      .where(and(inArray(mediaJobs.id, unique), isNotNull(mediaJobs.deletedAt), userId ? eq(mediaJobs.userId, userId) : undefined))
      .returning();
    const fileIds = rows.flatMap((r) => r.resultFileIds);
    if (fileIds.length) await this.d.db.update(files).set({ deletedAt: null }).where(inArray(files.id, fileIds));
    if (rows.length) this.d.log.info('trash.jobs_restored', { count: rows.length });
    return rows.map((r) => r.id);
  }

  // ── admin view ────────────────────────────────────────────────────────────

  async list(o: { graceDays: number; userId?: string; kind?: 'image' | 'video'; limit?: number; before?: string }): Promise<{ items: TrashItem[]; nextBefore: string | null }> {
    const limit = Math.min(Math.max(o.limit ?? 50, 1), 200);
    const conds: (SQL | undefined)[] = [isNotNull(mediaJobs.deletedAt)];
    if (o.userId) conds.push(eq(mediaJobs.userId, o.userId));
    if (o.kind) conds.push(eq(mediaJobs.kind, o.kind));
    if (o.before) conds.push(lt(mediaJobs.deletedAt, new Date(o.before)));
    const rows = await this.d.db
      .select({ job: mediaJobs, email: users.email })
      .from(mediaJobs)
      .innerJoin(users, eq(users.id, mediaJobs.userId))
      .where(and(...conds))
      .orderBy(desc(mediaJobs.deletedAt))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const items = await Promise.all(
      page.map(async ({ job, email }) => {
        const view = await this.d.media.jobView(job, 'trash');
        return {
          job: view,
          user: { id: job.userId, email },
          deletedAt: job.deletedAt!.toISOString(),
          deletedBy: job.deletedBy,
          purgeAt: new Date(job.deletedAt!.getTime() + o.graceDays * 86400_000).toISOString(),
          bytes: view.outputs.reduce((sum, a) => sum + a.size, 0),
        };
      }),
    );
    return { items, nextBefore: rows.length > limit ? page.at(-1)!.job.deletedAt!.toISOString() : null };
  }

  /** Totals for the admin page: live media vs. what sits in the trash. */
  async stats() {
    const [live] = await this.d.db
      .select({ count: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(${files.size}), 0)::bigint` })
      .from(files)
      .where(isNull(files.deletedAt));
    const [trashFiles] = await this.d.db
      .select({ count: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(${files.size}), 0)::bigint` })
      .from(files)
      .where(isNotNull(files.deletedAt));
    const [trashJobs] = await this.d.db.select({ count: sql<number>`count(*)::int` }).from(mediaJobs).where(isNotNull(mediaJobs.deletedAt));
    return {
      files: Number(live?.count ?? 0),
      bytes: Number(live?.bytes ?? 0),
      trashJobs: Number(trashJobs?.count ?? 0),
      trashFiles: Number(trashFiles?.count ?? 0),
      trashBytes: Number(trashFiles?.bytes ?? 0),
    };
  }

  // ── purge ─────────────────────────────────────────────────────────────────

  /** Delete trashed jobs for good: the job rows, their hidden conversations and every output nothing else uses. */
  async purge(ids: string[], o: { dryRun?: boolean; counts?: PurgeCounts } = {}): Promise<PurgeCounts> {
    const counts = o.counts ?? emptyCounts();
    const unique = [...new Set(ids)];
    if (!unique.length) return counts;
    const jobs = await this.d.db
      .select()
      .from(mediaJobs)
      .where(and(inArray(mediaJobs.id, unique), isNotNull(mediaJobs.deletedAt)));
    if (!jobs.length) return counts;
    const jobIds = jobs.map((j) => j.id);
    // face swap intermediates (close-up engines: the swapped photo, the crop, Qoder's raw edits incl. misaligned ones)
    // go with the job too, unless something else uses them
    // head swap: every candidate's raw Qoder output and composite
    const intermediates = jobs.flatMap((j) => {
      const fs = (j.request.face_swap ?? {}) as {
        swapped_file_id?: unknown;
        crop_file_id?: unknown;
        qoder_output_file_id?: unknown;
        misaligned_file_ids?: unknown;
        candidates?: unknown;
      };
      const misaligned = Array.isArray(fs.misaligned_file_ids) ? fs.misaligned_file_ids : [];
      const candidates = Array.isArray(fs.candidates) ? (fs.candidates as { file_id?: unknown; composite_file_id?: unknown }[]).flatMap((c) => [c?.file_id, c?.composite_file_id]) : [];
      return [fs.swapped_file_id, fs.crop_file_id, fs.qoder_output_file_id, ...misaligned, ...candidates].filter((x): x is string => typeof x === 'string');
    });
    const outputs = await this.fileRows([...jobs.flatMap((j) => j.resultFileIds), ...intermediates]);
    if (!o.dryRun) {
      await this.d.db.delete(conversations).where(inArray(sql`${conversations.metadata}->>'job_id'`, jobIds));
      await this.d.db.delete(mediaJobs).where(inArray(mediaJobs.id, jobIds));
    }
    counts.jobsPurged += jobs.length;
    await this.removeUnused(outputs, { chats: 'active', excludeJobIds: jobIds, dryRun: o.dryRun, counts });
    if (!o.dryRun) this.d.log.info('trash.jobs_purged', { count: jobs.length });
    return counts;
  }

  /** Trashed jobs whose grace period is over. */
  async expired(cutoff: Date, limit: number): Promise<MediaJob[]> {
    return this.d.db
      .select()
      .from(mediaJobs)
      .where(and(isNotNull(mediaJobs.deletedAt), lt(mediaJobs.deletedAt, cutoff)))
      .limit(limit);
  }

  /**
   * Delete files from disk and DB unless still in use. `chats: 'active'` counts only chats that are not archived
   * as users; `'all'` counts archived chats too. Jobs in `excludeJobIds` (being purged) do not count as users.
   */
  async removeUnused(
    rows: StoredFile[],
    o: { chats: 'active' | 'all'; excludeJobIds?: string[]; dryRun?: boolean; counts: PurgeCounts },
  ): Promise<void> {
    for (const file of rows) {
      try {
        if (await this.inUse(file.id, o.chats, o.excludeJobIds ?? [])) {
          o.counts.filesInUse++;
          continue;
        }
        o.counts.bytesFreed += o.dryRun ? file.size : await this.d.store.remove(file);
        o.counts.filesDeleted++;
      } catch (err) {
        o.counts.errors++;
        this.d.log.warn('trash.file_remove_failed', { fileId: file.id, err });
      }
    }
  }

  async fileRows(ids: string[]): Promise<StoredFile[]> {
    const unique = [...new Set(ids)];
    return unique.length ? this.d.db.select().from(files).where(inArray(files.id, unique)) : [];
  }

  // ── references ────────────────────────────────────────────────────────────

  /** Hide trashed outputs (their URLs 404), except files a live chat message shows or a saved face uses. */
  private async hideFiles(ids: string[], at: Date) {
    const hide: string[] = [];
    for (const id of new Set(ids)) if (!(await this.inChat(id, 'active')) && !(await this.inFace(id))) hide.push(id);
    if (hide.length) await this.d.db.update(files).set({ deletedAt: at }).where(inArray(files.id, hide));
  }

  private async inUse(fileId: string, chats: 'active' | 'all', excludeJobIds: string[]): Promise<boolean> {
    return (await this.inJob(fileId, excludeJobIds)) || (await this.inChat(fileId, chats)) || (await this.inFace(fileId));
  }

  /** Image of a saved face (face swap): the main image, the front portrait or the cached head swap combo. */
  private async inFace(fileId: string): Promise<boolean> {
    const [row] = await this.d.db
      .select({ id: faces.id })
      .from(faces)
      .where(or(eq(faces.fileId, fileId), eq(faces.portraitFileId, fileId), eq(faces.comboFileId, fileId)))
      .limit(1);
    return !!row;
  }

  /** Output or input (edit image, video frame, reference) of any remaining job, trashed ones included. */
  private async inJob(fileId: string, excludeJobIds: string[]): Promise<boolean> {
    const list = JSON.stringify([fileId]);
    const [row] = await this.d.db
      .select({ id: mediaJobs.id })
      .from(mediaJobs)
      .where(
        and(
          excludeJobIds.length ? notInArray(mediaJobs.id, excludeJobIds) : undefined,
          or(
            sql`${mediaJobs.resultFileIds} @> ${list}::jsonb`,
            sql`${mediaJobs.request}->'input_file_ids' @> ${list}::jsonb`,
            sql`${mediaJobs.request}->'reference_file_ids' @> ${list}::jsonb`,
            sql`${mediaJobs.request}->>'first_frame_file_id' = ${fileId}`,
            sql`${mediaJobs.request}->>'last_frame_file_id' = ${fileId}`,
            // face swap: the target photo (a close-up job's inputs are the crop + face) and its intermediates
            sql`${mediaJobs.request}->'face_swap'->>'source_file_id' = ${fileId}`,
            sql`${mediaJobs.request}->'face_swap'->>'qoder_output_file_id' = ${fileId}`,
            sql`${mediaJobs.request}->'face_swap'->>'swapped_file_id' = ${fileId}`,
            sql`${mediaJobs.request}->'face_swap'->'misaligned_file_ids' @> ${list}::jsonb`,
            // head swap: the portrait (identity source), and each candidate's reference image, raw Qoder output and composite
            sql`${mediaJobs.request}->'face_swap'->>'portrait_file_id' = ${fileId}`,
            sql`${mediaJobs.request}->'face_swap'->'candidates' @> ${JSON.stringify([{ reference_file_id: fileId }])}::jsonb`,
            sql`${mediaJobs.request}->'face_swap'->'candidates' @> ${JSON.stringify([{ file_id: fileId }])}::jsonb`,
            sql`${mediaJobs.request}->'face_swap'->'candidates' @> ${JSON.stringify([{ composite_file_id: fileId }])}::jsonb`,
          ),
        ),
      )
      .limit(1);
    return !!row;
  }

  /** Attachment or artifact of a message in a visible chat (`active` = not archived). Media-job chats don't count. */
  private async inChat(fileId: string, chats: 'active' | 'all'): Promise<boolean> {
    const ref = JSON.stringify([{ fileId }]);
    const [row] = await this.d.db
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(
        and(
          or(sql`${messages.content} @> ${ref}::jsonb`, sql`${messages.artifacts} @> ${ref}::jsonb`),
          sql`coalesce(${conversations.metadata}->>'hidden', 'false') <> 'true'`,
          chats === 'active' ? isNull(conversations.archivedAt) : undefined,
        ),
      )
      .limit(1);
    return !!row;
  }
}
