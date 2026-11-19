import type { UserRow } from '../auth/auth.js';
import type { AppContext } from '../context.js';
import type { ContentBlock } from '../db/schema.js';
import { AppError, badRequest } from '../errors.js';
import { sha256 } from '../ids.js';
import { type CompatMessage, type ConversationRow, transcriptPreamble } from './conversations.js';
import type { ProfileName } from './profiles.js';
import type { TurnHandle, TurnResult } from './turns.js';

/** Max bytes we accept for an inline/URL image or document in compat requests. */
const MAX_INGEST_BYTES = 20 * 1024 * 1024;

export interface CompatTurnRequest {
  user: UserRow;
  source: 'openai' | 'anthropic';
  model: string;
  profile: ProfileName;
  system?: string | null;
  /** Full history the client sent, oldest first, EXCLUDING the final user message. */
  history: CompatMessage[];
  /** The final user message, already converted to our content blocks (files ingested). */
  last: ContentBlock[];
  /** Same message in CompatMessage form (for fingerprinting). */
  lastCompat: CompatMessage;
  /** Explicit conversation (header X-StillGPT-Conversation / metadata.conversation_id). */
  conversationId?: string | null;
}

export interface CompatTurn {
  conversation: ConversationRow;
  handle: TurnHandle;
  /** True when the client history was not recognised and had to be replayed as a transcript. */
  replayedHistory: boolean;
}

/**
 * Stateless (OpenAI/Anthropic) request → stateful conversation turn.
 * See ARCHITECTURE §5: history prefix fingerprint → existing session, else new session + transcript.
 * After the turn completes, the fingerprint of (history + last + reply) is stored so the next call hits.
 */
export async function startCompatTurn(ctx: AppContext, r: CompatTurnRequest): Promise<CompatTurn> {
  // a Folax model that cannot take this request fails before a conversation is created or switched to it
  ctx.turns.assertFolaxRequest(r.model, r.last);
  const scope = `${r.source}|${r.profile}|${sha256(r.system ?? '')}`;
  let conversation: ConversationRow | null = null;
  let preamble: string | undefined;

  if (r.conversationId) {
    conversation = await ctx.conversations.get(r.conversationId, r.user.id);
  } else if (r.history.length) {
    conversation = await ctx.conversations.findThread(ctx.conversations.threadKey(r.user.id, scope, r.history), r.user.id);
    if (!conversation) preamble = transcriptPreamble(r.history);
  }

  if (!conversation) {
    conversation = await ctx.conversations.create({
      userId: r.user.id,
      profile: r.profile,
      model: r.model,
      systemPrompt: r.system ?? null,
      source: r.source,
    });
  } else if (conversation.model !== r.model || (conversation.systemPrompt ?? null) !== (r.system ?? null) || conversation.profile !== r.profile) {
    // client changed model/system/profile between calls → apply to the existing session
    conversation = await ctx.conversations.update(conversation.id, r.user.id, { model: r.model, systemPrompt: r.system ?? null, profile: r.profile });
  }

  const conv = conversation;
  // Store the fingerprint of (history + last + reply) before the turn reports completion, so a client that
  // fires its next request immediately always finds this conversation.
  const remember = async (result: TurnResult) => {
    if (result.stopReason === 'error') return;
    const full: CompatMessage[] = [...r.history, r.lastCompat, { role: 'assistant', text: result.text }];
    await ctx.conversations.rememberThread(ctx.conversations.threadKey(r.user.id, scope, full), conv.id, r.user.id);
  };
  const handle = await ctx.turns.start({ conversationId: conv.id, userId: r.user.id, content: r.last, preamble, beforeComplete: remember });

  return { conversation, handle, replayedHistory: !!preamble };
}

export interface IngestedFile {
  block: ContentBlock;
  /** Stable digest for fingerprinting (sha256 of bytes). */
  digest: string;
}

/**
 * Store an image/document given as data URL, raw base64 or http(s) URL; returns a content block.
 * Images in vision formats become `image` blocks, everything else `document` blocks (mounted in the sandbox).
 */
export async function ingestFile(
  ctx: AppContext,
  userId: string,
  src: { dataUrl?: string; base64?: string; url?: string; mediaType?: string; filename?: string },
): Promise<IngestedFile> {
  let bytes: Buffer;
  let mediaType = src.mediaType ?? '';
  if (src.dataUrl) {
    const m = src.dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!m) throw badRequest('Invalid data URL', 'invalid_image');
    mediaType ||= m[1] ?? 'application/octet-stream';
    bytes = m[2] ? Buffer.from(m[3]!, 'base64') : Buffer.from(decodeURIComponent(m[3]!));
  } else if (src.base64) {
    bytes = Buffer.from(src.base64, 'base64');
  } else if (src.url) {
    if (!/^https?:\/\//i.test(src.url)) throw badRequest('Only http(s) URLs are supported', 'invalid_url');
    const res = await fetch(src.url, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (!res?.ok) throw badRequest(`Could not download ${src.url}`, 'download_failed');
    mediaType ||= res.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream';
    bytes = Buffer.from(await res.arrayBuffer());
  } else {
    throw badRequest('File content missing');
  }
  if (!bytes.length) throw badRequest('File is empty');
  if (bytes.length > MAX_INGEST_BYTES) throw new AppError(413, 'file_too_large', 'File exceeds 20 MB');

  mediaType ||= 'application/octet-stream';
  const isImage = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType);
  const filename = src.filename ?? `${isImage ? 'image' : 'file'}.${extFor(mediaType)}`;
  const file = await ctx.store.save({ userId, kind: 'upload', filename, mimeType: mediaType, bytes });
  const block: ContentBlock = isImage
    ? { type: 'image', fileId: file.id, mimeType: mediaType }
    : { type: 'document', fileId: file.id, filename: file.filename, mimeType: mediaType };
  return { block, digest: file.sha256 };
}

function extFor(mime: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'text/csv': 'csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  };
  return map[mime] ?? 'bin';
}

/** Rough token estimate — Qoder does not expose token counts. */
export const estimateTokens = (s: string) => Math.max(1, Math.ceil(s.length / 4));

/** Response headers every compat endpoint sets. */
export function compatHeaders(conversationId: string, model: string, credits?: number): Record<string, string> {
  return {
    'X-StillGPT-Conversation': conversationId,
    'X-StillGPT-Model': model,
    ...(credits !== undefined ? { 'X-StillGPT-Credits': String(credits) } : {}),
  };
}
