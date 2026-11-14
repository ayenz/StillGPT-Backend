import type { z } from 'zod';
import type { AppContext } from '../../context.js';
import { ingestFile } from '../../core/compat.js';
import type { CompatMessage } from '../../core/conversations.js';
import type { Artifact } from '../../core/events.js';
import type { ContentBlock } from '../../db/schema.js';
import { AppError, badRequest } from '../../errors.js';
import { sha256 } from '../../ids.js';

/** Provider-neutral content part, shared by chat completions and the Responses API. */
export type InputPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; url: string }
  | { kind: 'file'; data: string; filename?: string };

export interface InputMessage {
  role: 'user' | 'assistant';
  parts: InputPart[];
}

/** Zod parse that fails with an OpenAI-style 400 naming the offending field. */
export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  const param = issue.path.join('.') || null;
  throw badRequest(param ? `Invalid '${param}': ${issue.message}` : issue.message, 'invalid_request', { param });
}

export const toolsNotSupported = () =>
  new AppError(400, 'tools_not_supported', 'Tool/function calling is not supported yet; omit `tools` or set tool_choice to "none"');

/**
 * Lines that link to our own media store are artifact links we appended to a reply.
 * They are stripped from assistant history so the client's resent history fingerprints like the stored reply text.
 */
const ARTIFACT_LINK_LINE = /^!?\[[^\]\n]*\]\(https?:\/\/[^)\s]+\/media\/file_[^)\s]+\)$/;

export function stripArtifactLinks(text: string): string {
  return text
    .split('\n')
    .filter((line) => !ARTIFACT_LINK_LINE.test(line.trim()))
    .join('\n')
    .trim();
}

export function artifactMarkdown(a: Artifact): string {
  const name = a.name.replace(/[[\]]/g, '');
  return a.kind === 'image' ? `![${name}](${a.url})` : `[${name}](${a.url})`;
}

/** Final assistant content: reply text followed by one markdown link per delivered artifact. */
export function contentWithArtifacts(text: string, artifacts: Artifact[]): string {
  return [text, ...artifacts.map(artifactMarkdown)].filter(Boolean).join('\n\n');
}

export const messageText = (m: InputMessage) =>
  m.parts
    .filter((p): p is Extract<InputPart, { kind: 'text' }> => p.kind === 'text')
    .map((p) => p.text)
    .join('\n');

/** Digest of the client-supplied reference (data URL / base64 / URL) — stable across resends, no download needed. */
const partDigest = (p: Exclude<InputPart, { kind: 'text' }>) => sha256(p.kind === 'image' ? p.url : p.data);

export function toCompatMessage(m: InputMessage): CompatMessage {
  const text = messageText(m);
  const attachments = m.parts.filter((p): p is Exclude<InputPart, { kind: 'text' }> => p.kind !== 'text').map(partDigest);
  return {
    role: m.role,
    text: m.role === 'assistant' ? stripArtifactLinks(text) : text,
    ...(attachments.length ? { attachments } : {}),
  };
}

/** Converts the final user message into turn content blocks, storing images/files. */
export async function ingestMessage(ctx: AppContext, userId: string, m: InputMessage): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  for (const p of m.parts) {
    if (p.kind === 'text') {
      if (p.text) blocks.push({ type: 'text', text: p.text });
    } else if (p.kind === 'image') {
      const src = p.url.startsWith('data:') ? { dataUrl: p.url } : { url: p.url };
      blocks.push((await ingestFile(ctx, userId, src)).block);
    } else {
      const src = p.data.startsWith('data:') ? { dataUrl: p.data } : { base64: p.data };
      blocks.push((await ingestFile(ctx, userId, { ...src, filename: p.filename, mediaType: p.data.startsWith('data:') ? undefined : mimeFromName(p.filename) })).block);
    }
  }
  if (!blocks.length) throw badRequest('The last user message is empty', 'invalid_request', { param: 'messages' });
  return blocks;
}

function mimeFromName(filename?: string): string | undefined {
  const ext = filename?.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return ext ? map[ext] : undefined;
}

/** Instruction appended to the system prompt for `response_format` / `text.format`. */
export function jsonInstruction(format: { type: string; schema?: unknown; name?: string } | undefined): string | null {
  if (!format || format.type === 'text') return null;
  const base = 'Respond with a single valid JSON value only: no prose, no explanations and no Markdown code fences.';
  if (format.type === 'json_schema' && format.schema !== undefined) {
    return `${base} The JSON must conform to this JSON Schema${format.name ? ` ("${format.name}")` : ''}:\n${JSON.stringify(format.schema)}`;
  }
  return `${base} Return a JSON object.`;
}

export function joinSystem(parts: (string | null | undefined)[]): string | null {
  const s = parts.filter((p): p is string => !!p?.trim()).join('\n\n');
  return s || null;
}
