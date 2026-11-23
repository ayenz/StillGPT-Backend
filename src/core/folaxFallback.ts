import type { ContentBlock } from '../db/schema.js';
import { AppError } from '../errors.js';
import type { Logger } from '../log.js';
import type { FolaxClient } from '../providers/folax.js';
import { buildFolaxMessages } from './folaxChat.js';
import type { MediaStore } from './storage.js';

/**
 * Folax as the fallback for the hidden Qoder helper turns (prompt enhancer, variations, image descriptions): when
 * Qoder is down, out of credits, slow or answers with something unusable, the same prompt goes to Folax (free).
 */

/**
 * Folax's upstream filter rejects the whole request ("The current information may contain inappropriate content…")
 * when any of these words appears, even inside our own safety rules (2026-11-23: every model, every time).
 */
const FOLAX_BLOCKED_WORDS = /\b(sex\w*|nud\w*|naked|minors?|busty|porn\w*|erotic\w*)\b/i;
const FOLAX_FILTER_REPLY = /may contain inappropriate content/i;
/** Tags around user data in our prompts; their content is never touched. */
const DATA_BLOCK = /^<(idea|prompt|user-words|earlier)>$/;

/**
 * The prompt without our rule lines (`- …`) that Folax's filter rejects. User data stays as it is: the `<hints>` line,
 * blocks like `<idea>…</idea>` (their text is fenced, so they cannot close early) and image descriptions.
 */
export function folaxSafePrompt(text: string): string {
  let inside: string | null = null;
  return text
    .split('\n')
    .filter((line) => {
      if (inside) {
        if (line === `</${inside}>`) inside = null;
        return true;
      }
      const open = line.match(DATA_BLOCK);
      if (open) {
        inside = open[1]!;
        return true;
      }
      return !(line.trimStart().startsWith('- ') && FOLAX_BLOCKED_WORDS.test(line));
    })
    .join('\n');
}

/** Waits for a Qoder turn up to `ms`; null when it took longer (the caller interrupts it). */
export async function withinMs<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** Calls with images in flight at once: the adapter's slots are shared with user chats and media jobs. */
const VISION_SLOTS = 3;
let visionActive = 0;
const visionQueue: (() => void)[] = [];
async function visionSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (visionActive >= VISION_SLOTS) await new Promise<void>((r) => visionQueue.push(r));
  else visionActive++;
  try {
    return await fn();
  } finally {
    const next = visionQueue.shift();
    if (next) next();
    else visionActive--;
  }
}

export interface AskFolax<T> {
  folax: FolaxClient | null | undefined;
  log: Logger;
  /** Log key, e.g. `enhancer` → `enhancer.folax_fallback`. */
  what: string;
  /** Tried in order until one gives a usable reply. With images every model is the same vision model: give one. */
  models: readonly string[];
  /** Text and images of the prompt; text goes through `folaxSafePrompt`. Images need `store` + `userId`. */
  content: ContentBlock[];
  store?: MediaStore;
  userId?: string;
  /** Parses the reply; null = unusable (the next model is tried). */
  parse: (text: string) => T | null;
  timeoutMs?: number;
}

/** The first usable Folax reply as `{model: 'folax/<id>', value}`, or null (not configured, known down, all failed). */
export async function askFolax<T>(o: AskFolax<T>): Promise<{ model: string; value: T } | null> {
  const folax = o.folax;
  if (!folax || folax.knownDown()) return null;
  const content = o.content.map((b) => (b.type === 'text' ? { ...b, text: folaxSafePrompt(b.text) } : b));
  const hasImages = content.some((b) => b.type === 'image');
  const call = async (model: string) => {
    const messages = await buildFolaxMessages({ system: '', history: [], current: content, store: o.store!, userId: o.userId ?? '' });
    let reply = '';
    for await (const piece of await folax.chat({ model, messages, timeoutMs: o.timeoutMs ?? 60_000 })) reply += piece;
    return reply;
  };
  for (const model of o.models) {
    const started = Date.now();
    try {
      let reply: string;
      try {
        reply = hasImages ? await visionSlot(() => call(model)) : await call(model);
      } catch (err) {
        // the adapter's queue was full: one more try after a short pause
        if (!(err instanceof AppError && err.code === 'provider_busy')) throw err;
        await new Promise((r) => setTimeout(r, 2000));
        reply = hasImages ? await visionSlot(() => call(model)) : await call(model);
      }
      const value = o.parse(reply);
      o.log.info(`${o.what}.folax_fallback`, { model, ok: value !== null, ms: Date.now() - started });
      if (value !== null) return { model: `folax/${model}`, value };
      // the user's own text tripped Folax's filter: every model gets the same answer
      if (FOLAX_FILTER_REPLY.test(reply)) return null;
    } catch (err) {
      o.log.warn(`${o.what}.folax_failed`, { model, err: (err as Error).message });
      if (folax.knownDown()) return null;
    }
  }
  return null;
}
