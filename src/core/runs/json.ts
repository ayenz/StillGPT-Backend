import type { z } from 'zod';

/**
 * The JSON value inside an LLM reply: tolerates code fences and chatter around it. Tries the whole text, then the
 * outermost {…} / […] span. Returns undefined when nothing parses.
 */
export function extractJson(text: string): unknown {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const candidates = [stripped];
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const a = stripped.indexOf(open);
    const b = stripped.lastIndexOf(close);
    if (a >= 0 && b > a) candidates.push(stripped.slice(a, b + 1));
  }
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // next candidate
    }
  }
  return undefined;
}

/** Parses and validates; returns the error text instead of throwing so callers can retry with it. */
export function parseJsonReply<T extends z.ZodType>(text: string, schema: T): { ok: true; value: z.infer<T> } | { ok: false; error: string } {
  const raw = extractJson(text);
  if (raw === undefined) return { ok: false, error: 'the reply contains no JSON' };
  const r = schema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
}

/** `<tag attrs>…</tag>` with closing tags inside the text neutralised, so user text cannot end the block early. */
export const fenced = (tag: string, text: string, attrs = '') => `<${tag}${attrs ? ` ${attrs}` : ''}>\n${text.replaceAll('</', '<\\/')}\n</${tag}>`;
