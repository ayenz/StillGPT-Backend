import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { UserRow } from '../../auth/auth.js';
import type { ConversationRow, MessageRow } from '../../core/conversations.js';
import type { Artifact, TurnEvent } from '../../core/events.js';
import { artifactKind } from '../../core/events.js';
import type { MediaStore, StoredFile } from '../../core/storage.js';
import { AppError, badRequest } from '../../errors.js';
import { jsonBody } from '../../http.js';

export const HEARTBEAT_MS = 15_000;

/** Parse + validate a JSON body; errors become 400 `validation_error` with per-field issues. */
export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  return parse(schema, await jsonBody(c));
}

export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  throw badRequest(issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; '), 'validation_error', { issues });
}

/** `?limit=` as an integer within bounds. */
export function limitParam(raw: string | undefined, def: number, max: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : def;
}

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

// ── views (snake_case JSON) ─────────────────────────────────────────────────

export const userView = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  display_name: u.displayName,
  role: u.role,
  monthly_credit_limit: u.monthlyCreditLimit,
  disabled: !!u.disabledAt,
  created_at: iso(u.createdAt),
});

export const conversationView = (c: ConversationRow) => ({
  id: c.id,
  title: c.title,
  model: c.model,
  resolved_model: c.resolvedModel,
  profile: c.profile,
  system_prompt: c.systemPrompt,
  status: c.status,
  created_at: iso(c.createdAt),
  updated_at: iso(c.updatedAt),
});

export const artifactView = (a: Artifact) => ({
  id: a.id,
  name: a.name,
  mime_type: a.mimeType,
  size: a.size,
  kind: a.kind,
  url: a.url,
  thumbnail_url: a.thumbnailUrl ?? null,
  preview_url: a.previewUrl ?? null,
});

/** `url`, `thumbnail_url`, `preview_url` for a stored file id. */
const mediaUrls = (store: MediaStore, fileId: string, mimeType: string) => {
  const u = store.urls(fileId, mimeType);
  return { url: u.url, thumbnail_url: u.thumbnailUrl, preview_url: u.previewUrl };
};

export const fileView = (f: StoredFile, store: MediaStore) => ({
  id: f.id,
  filename: f.filename,
  mime_type: f.mimeType,
  size: f.size,
  kind: f.kind,
  ...mediaUrls(store, f.id, f.mimeType),
  created_at: iso(f.createdAt),
});

export function messageView(m: MessageRow, store: MediaStore) {
  return {
    id: m.id,
    role: m.role,
    content: m.content.map((b) => {
      if (b.type === 'text') return { type: 'text' as const, text: b.text };
      if (b.type === 'image') return { type: 'image' as const, file_id: b.fileId, mime_type: b.mimeType, ...mediaUrls(store, b.fileId, b.mimeType) };
      return { type: 'file' as const, file_id: b.fileId, filename: b.filename, mime_type: b.mimeType, ...mediaUrls(store, b.fileId, b.mimeType) };
    }),
    artifacts: m.artifacts.map((a) =>
      artifactView({ id: a.fileId, name: a.name, mimeType: a.mimeType, size: a.size, kind: a.kind ?? artifactKind(a.mimeType), ...store.urls(a.fileId, a.mimeType) }),
    ),
    model: m.model,
    credits: m.credits,
    stop_reason: m.stopReason,
    error: m.error ?? null,
    created_at: iso(m.createdAt),
  };
}

/** TurnEvent → snake_case wire JSON (explicit so tool inputs are passed through untouched). */
export function turnEventView(e: TurnEvent): Record<string, unknown> {
  switch (e.type) {
    case 'turn.started':
      return { type: e.type, conversation_id: e.conversationId, message_id: e.messageId, model: e.model };
    case 'conversation.title':
      return { type: e.type, conversation_id: e.conversationId, title: e.title };
    case 'run.event':
      return { type: e.type, run_id: e.runId, event: e.event };
    case 'tool.completed':
      return { type: e.type, id: e.id, is_error: e.isError, output: e.output };
    case 'artifact':
      return { type: e.type, artifact: artifactView(e.artifact) };
    case 'turn.completed':
      return {
        type: e.type,
        message_id: e.messageId,
        stop_reason: e.stopReason,
        text: e.text,
        artifacts: e.artifacts.map(artifactView),
        credits: e.credits,
      };
    default:
      return { ...e };
  }
}

// ── SSE ─────────────────────────────────────────────────────────────────────

export interface SseEvent {
  event: string;
  data: unknown;
  id?: string | number;
}

/**
 * Stream an async iterable as SSE with a heartbeat comment. The iterable receives an AbortSignal
 * that fires when the client goes away — the producer (turn/job) itself keeps running.
 */
export function sse(c: Context, source: (signal: AbortSignal) => AsyncIterable<SseEvent>) {
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async (stream) => {
    const ctrl = new AbortController();
    stream.onAbort(() => ctrl.abort());
    const heartbeat = setInterval(() => void stream.write(': ping\n\n').catch(() => ctrl.abort()), HEARTBEAT_MS);
    try {
      for await (const e of source(ctrl.signal)) {
        if (stream.aborted || stream.closed) break;
        await stream.writeSSE({ event: e.event, data: JSON.stringify(e.data), ...(e.id !== undefined ? { id: String(e.id) } : {}) });
      }
    } finally {
      clearInterval(heartbeat);
      ctrl.abort();
    }
  });
}

export const wantsStream = (c: Context) => c.req.query('stream') === 'true' || (c.req.header('accept') ?? '').includes('text/event-stream');

// ── uploads ─────────────────────────────────────────────────────────────────

/** Large images are fine: the copy sent upstream is shrunk (attachments.shrinkImage). Documents stay capped at 5 MB by Qoder. */
export const UPLOAD_LIMIT = 50 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
};

/** Browser-reported type, else by extension (multipart parts from scripts often say octet-stream). */
export function mimeOf(file: File): string {
  const reported = file.type.split(';')[0]!.trim();
  if (reported && reported !== 'application/octet-stream') return reported;
  return MIME_BY_EXT[file.name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

/** Rejects oversized multipart requests before buffering them. */
export function assertUploadSize(c: Context, max = UPLOAD_LIMIT) {
  const len = Number(c.req.header('content-length'));
  // multipart framing adds a little; allow 1 MB of overhead
  if (Number.isFinite(len) && len > max + 1024 * 1024) throw new AppError(413, 'file_too_large', `Uploads are limited to ${max / 1024 / 1024} MB`);
}

export async function saveUpload(store: MediaStore, userId: string, file: File, max = UPLOAD_LIMIT): Promise<StoredFile> {
  if (file.size > max) throw new AppError(413, 'file_too_large', `${file.name} exceeds the upload limit of ${max / 1024 / 1024} MB`);
  if (file.size === 0) throw badRequest('The uploaded file is empty', 'validation_error');
  return store.save({ userId, kind: 'upload', filename: file.name || 'upload', mimeType: mimeOf(file), bytes: Buffer.from(await file.arrayBuffer()) });
}

/** Multipart form values for `name` (also `name[]`), files only. */
export function formFiles(form: Record<string, unknown>, name: string): File[] {
  const values = [form[name], form[`${name}[]`]].flatMap((v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]));
  return values.filter((v): v is File => v instanceof File);
}
