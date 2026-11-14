import type { AppContext } from '../../context.js';
import { ingestFile } from '../../core/compat.js';
import type { CompatMessage } from '../../core/conversations.js';
import type { Artifact, StopReason } from '../../core/events.js';
import { sanitizeFilename } from '../../core/storage.js';
import type { ContentBlock } from '../../db/schema.js';
import { badRequest } from '../../errors.js';
import { sha256 } from '../../ids.js';
import type { ContentBlockIn, CountTokensRequest, DocumentBlockIn, FileBlockIn, MessageIn } from './schema.js';

export type AnthropicStopReason = 'end_turn' | 'max_tokens';

export function toAnthropicStop(reason: StopReason): AnthropicStopReason {
  return reason === 'budget_exceeded' ? 'max_tokens' : 'end_turn';
}

const blocksOf = (m: MessageIn): ContentBlockIn[] => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content);

export function systemText(system: CountTokensRequest['system']): string | null {
  if (system === undefined) return null;
  const text = typeof system === 'string' ? system : system.map((b) => b.text).join('\n');
  return text.trim() ? text : null;
}

/** Tool calling is phase 2 (ARCHITECTURE §5): reject anything that would need it. */
export function assertNoTools(req: CountTokensRequest) {
  const usesToolBlocks = req.messages.some((m) => blocksOf(m).some((b) => b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'server_tool_use'));
  if (req.tools?.length || usesToolBlocks) throw badRequest('Tool use is not supported yet', 'tools_not_supported');
}

// ── artifacts as markdown ───────────────────────────────────────────────────

export const artifactMarkdown = (a: Artifact) => `\n\n${a.kind === 'image' ? '!' : ''}[${a.name.replace(/[[\]]/g, '')}](${a.url})`;

/** Links we appended to earlier replies; signed URLs change, so they must not affect history fingerprints. */
const ARTIFACT_LINK = /\n*!?\[[^\]\n]*\]\([^)\s]*\/media\/file_[a-z0-9]+\?exp=\d+&sig=[\w-]+\)/g;

export const stripArtifactLinks = (text: string) => text.replace(ARTIFACT_LINK, '');

// ── messages → compat form ──────────────────────────────────────────────────

function documentName(b: DocumentBlockIn): string | undefined {
  if (!b.title?.trim()) return undefined;
  const name = sanitizeFilename(b.title.trim());
  if (/\.\w{1,5}$/.test(name)) return name;
  const ext = b.source.type === 'base64' && b.source.media_type === 'application/pdf' ? 'pdf' : b.source.type === 'url' ? '' : 'txt';
  return ext ? `${name}.${ext}` : name;
}

function documentText(b: DocumentBlockIn): string | undefined {
  const s = b.source;
  if (s.type === 'text') return s.data;
  if (s.type === 'content') return typeof s.content === 'string' ? s.content : s.content.map((c) => c.text ?? '').join('\n');
  return undefined;
}

/** Stable identity of an attached file, computed without storing or downloading it. */
function fileDigest(b: FileBlockIn): string {
  const s = b.source;
  if (s.type === 'base64') return sha256(Buffer.from(s.data, 'base64'));
  if (s.type === 'url') return sha256(`url:${s.url}`);
  return sha256(Buffer.from(documentText(b as DocumentBlockIn) ?? '', 'utf8'));
}

function placeholder(b: FileBlockIn): string {
  return b.type === 'image' ? '[image]' : `[document: ${documentName(b) ?? 'file'}]`;
}

/** Text + attachment digests used for thread fingerprints, transcripts and token estimates. */
export function toCompatMessage(m: MessageIn): CompatMessage {
  const parts: string[] = [];
  const attachments: string[] = [];
  for (const b of blocksOf(m)) {
    if (b.type === 'text') parts.push(b.text);
    else if (b.type === 'image' || b.type === 'document') {
      parts.push(placeholder(b));
      attachments.push(fileDigest(b));
    }
  }
  const text = parts.join('\n');
  return { role: m.role, text: m.role === 'assistant' ? stripArtifactLinks(text) : text, ...(attachments.length ? { attachments } : {}) };
}

/** Rough prompt size: system + every message's text (+ tool definitions for count_tokens). */
export function promptText(req: CountTokensRequest): string {
  const parts = [systemText(req.system) ?? '', ...req.messages.map((m) => toCompatMessage(m).text)];
  if (req.tools?.length) parts.push(JSON.stringify(req.tools));
  return parts.join('\n');
}

// ── final user message → stored content blocks ──────────────────────────────

async function ingestBlock(ctx: AppContext, userId: string, b: FileBlockIn): Promise<ContentBlock> {
  const s = b.source;
  const filename = b.type === 'document' ? documentName(b) : undefined;
  if (s.type === 'base64') return (await ingestFile(ctx, userId, { base64: s.data, mediaType: s.media_type, filename })).block;
  if (s.type === 'url') return (await ingestFile(ctx, userId, { url: s.url, filename })).block;
  const text = documentText(b as DocumentBlockIn) ?? '';
  return (await ingestFile(ctx, userId, { base64: Buffer.from(text, 'utf8').toString('base64'), mediaType: 'text/plain', filename })).block;
}

export async function toContentBlocks(ctx: AppContext, userId: string, m: MessageIn): Promise<ContentBlock[]> {
  const out: ContentBlock[] = [];
  for (const b of blocksOf(m)) {
    if (b.type === 'text') out.push({ type: 'text', text: b.text });
    else if (b.type === 'image' || b.type === 'document') out.push(await ingestBlock(ctx, userId, b));
  }
  return out;
}
