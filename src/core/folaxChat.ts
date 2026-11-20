import type { ContentBlock } from '../db/schema.js';
import { badRequest } from '../errors.js';
import type { FolaxChatMessage } from '../providers/folax.js';
import { shrinkImage } from './attachments.js';
import type { MediaStore } from './storage.js';

/**
 * Folax chat models (folax-adapter `/v1/chat/completions`). Public ids are `folax/<id>`, mirroring the adapter ids.
 * Every model answers as "Folax by Infinix" (server-forced persona), has no tools, and with an image attached the
 * choice is ignored (one shared vision model). Chat only: no documents, no sandbox, no internal one-shot turns.
 */
export const FOLAX_CHAT_MODELS = [
  { id: 'folax', name: 'Folax' },
  { id: 'chatgpt', name: 'ChatGPT' },
  { id: 'gemini', name: 'Gemini' },
  { id: 'metaai', name: 'Meta AI' },
  { id: 'grok', name: 'Grok' },
] as const;

export const FOLAX_MODEL_PREFIX = 'folax/';

/** True for any `folax/…` id (valid or not), so such ids never silently fall back to a Qoder model. */
export const isFolaxModelId = (id: string | null | undefined) => (id ?? '').trim().toLowerCase().startsWith(FOLAX_MODEL_PREFIX);

/** `folax/chatgpt` → `chatgpt`; throws 400 model_not_found for an unknown Folax model. */
export function folaxModelName(id: string): string {
  const name = id.trim().toLowerCase().slice(FOLAX_MODEL_PREFIX.length);
  if (!FOLAX_CHAT_MODELS.some((m) => m.id === name))
    throw badRequest(`Unknown Folax model '${id}'; use one of ${FOLAX_CHAT_MODELS.map((m) => FOLAX_MODEL_PREFIX + m.id).join(', ')}`, 'model_not_found', { param: 'model' });
  return name;
}

/** Adapter limits (v0.6+: chat.max_messages 500, chat.max_input_characters 150000, chat.max_images 4 on the last message). */
export const FOLAX_LIMITS = {
  maxMessages: 500,
  /** Total characters we send (adapter v0.6+ rejects above 150000; keep a margin for "[image]" markers). */
  maxChars: 140_000,
  /** Longest user message we accept for a Folax model. */
  maxMessageChars: 100_000,
  /** System prompt (profile + conversation instructions) is cut here. */
  maxSystemChars: 20_000,
  /** Each earlier message is cut here, so more of the conversation fits. */
  maxHistoryMessageChars: 20_000,
  maxImages: 4,
  /** Adapter takes ≤ 10 MB per image; larger stills are shrunk. */
  maxImageBytes: 9 * 1024 * 1024,
} as const;

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Rejects (400, before the message is stored) what a Folax model cannot take: documents, GIFs, more than 4 images,
 * an over-long message.
 */
export function assertFolaxContent(content: ContentBlock[]) {
  if (content.some((b) => b.type === 'document'))
    throw badRequest('Folax models cannot read files; attach images only, or pick a Qoder model', 'unsupported_attachment');
  const images = content.filter((b) => b.type === 'image');
  if (images.some((b) => !IMAGE_TYPES.includes(b.mimeType)))
    throw badRequest('Folax models take JPEG, PNG or WebP images only', 'unsupported_attachment');
  if (images.length > FOLAX_LIMITS.maxImages) throw badRequest(`Folax models take at most ${FOLAX_LIMITS.maxImages} images per message`, 'too_many_images');
  const chars = content.reduce((n, b) => n + (b.type === 'text' ? b.text.length : 0), 0);
  if (chars > FOLAX_LIMITS.maxMessageChars)
    throw badRequest(`Folax models take at most ${FOLAX_LIMITS.maxMessageChars} characters per message`, 'message_too_long');
}

/** Never leaves half of a surrogate pair (emoji) at a cut: the adapter would choke on it when encoding UTF-8. */
const dropHalfPair = (s: string) => s.replace(/[\uD800-\uDBFF]$/, '').replace(/^[\uDC00-\uDFFF]/, '');
const cut = (s: string, max: number) => (s.length <= max ? s : `${dropHalfPair(s.slice(0, max - 1))}…`);

/** Text of earlier messages: attachments and generated files become markers (only the last message's images are sent). */
function historyText(m: FolaxHistoryMessage): string {
  return [
    ...m.content.map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : `[file: ${b.filename}]`)),
    ...(m.artifacts ?? []).map((a) => `[generated file: ${a.name}]`),
  ]
    .join('\n')
    .trim();
}

export interface FolaxHistoryMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
  /** Files a (Qoder) turn produced. */
  artifacts?: { name: string }[];
}

/**
 * OpenAI messages for one Folax turn: system, as much recent history as fits the adapter limits (newest kept first),
 * then the current message with its images as base64 data URLs. `preamble` (a transcript from a stateless client
 * whose history we did not know) goes in front of the current text.
 */
export async function buildFolaxMessages(o: {
  system: string;
  history: FolaxHistoryMessage[];
  current: ContentBlock[];
  preamble?: string;
  store: MediaStore;
  userId: string;
}): Promise<FolaxChatMessage[]> {
  const system = cut(o.system.trim(), FOLAX_LIMITS.maxSystemChars);
  const currentText = [o.preamble?.trim(), ...o.current.filter((b) => b.type === 'text').map((b) => b.text)].filter(Boolean).join('\n\n');
  const images = o.current.filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image').slice(0, FOLAX_LIMITS.maxImages);

  const parts: FolaxChatMessage['content'] = [];
  // the preamble can be long: keep its end (the most recent part) when it does not fit
  const room = FOLAX_LIMITS.maxChars - system.length - images.length * 8 - 64;
  const text = currentText.length > room ? `…${dropHalfPair(currentText.slice(currentText.length - room + 1))}` : currentText;
  if (text) parts.push({ type: 'text', text });
  for (const img of images) {
    const file = await o.store.get(img.fileId, o.userId);
    let bytes = await o.store.read(file);
    if (bytes.length > FOLAX_LIMITS.maxImageBytes) bytes = await shrinkImage(bytes, file.mimeType, FOLAX_LIMITS.maxImageBytes);
    parts.push({ type: 'image_url', image_url: { url: `data:${file.mimeType};base64,${bytes.toString('base64')}` } });
  }
  if (!parts.length) parts.push({ type: 'text', text: '…' });

  let budget = FOLAX_LIMITS.maxChars - system.length - text.length - images.length * 8;
  const earlier: FolaxChatMessage[] = [];
  for (let i = o.history.length - 1; i >= 0 && earlier.length < FOLAX_LIMITS.maxMessages - 2; i--) {
    const m = o.history[i]!;
    const t = cut(historyText(m), FOLAX_LIMITS.maxHistoryMessageChars);
    if (!t) continue;
    if (t.length > budget) break;
    budget -= t.length;
    earlier.unshift({ role: m.role, content: t });
  }
  return [...(system ? [{ role: 'system' as const, content: system }] : []), ...earlier, { role: 'user', content: parts }];
}
