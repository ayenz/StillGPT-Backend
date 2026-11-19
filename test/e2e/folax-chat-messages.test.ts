import { describe, expect, it } from 'vitest';
import { buildFolaxMessages, FOLAX_LIMITS } from '../../src/core/folaxChat.js';
import type { MediaStore } from '../../src/core/storage.js';

/** buildFolaxMessages: what one Folax turn sends (no images involved, so no store is needed). */
const store = {} as MediaStore;
const total = (msgs: { content: unknown }[]) =>
  msgs.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : (m.content as { text?: string }[]).reduce((k, p) => k + (p.text?.length ?? 8), 0)), 0);

describe('buildFolaxMessages', () => {
  it('keeps the newest history that fits the adapter limits, oldest first', async () => {
    const history = Array.from({ length: 300 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: [{ type: 'text' as const, text: `pesan ${i} ${'x'.repeat(200)}` }] }));
    const msgs = await buildFolaxMessages({ system: 'sys', history, current: [{ type: 'text', text: 'sekarang' }], store, userId: 'u' });
    expect(msgs.length).toBeLessThanOrEqual(FOLAX_LIMITS.maxMessages);
    expect(total(msgs)).toBeLessThanOrEqual(FOLAX_LIMITS.maxChars);
    expect(msgs[0]).toEqual({ role: 'system', content: 'sys' });
    expect(String(msgs.at(-2)!.content)).toContain('pesan 299');
    expect(msgs.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: 'sekarang' }] });
  });

  it('marks earlier attachments and generated files, and never cuts an emoji in half', async () => {
    const long = `${'a'.repeat(FOLAX_LIMITS.maxHistoryMessageChars - 2)}😀😀😀`;
    const msgs = await buildFolaxMessages({
      system: '',
      history: [
        { role: 'user', content: [{ type: 'text', text: long }, { type: 'document', fileId: 'f', filename: 'data.csv', mimeType: 'text/csv' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'sudah' }], artifacts: [{ name: 'chart.png' }] },
      ],
      current: [{ type: 'text', text: 'lanjut' }],
      store,
      userId: 'u',
    });
    const first = String(msgs[0]!.content);
    expect(first.endsWith('…')).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(first)).toBe(false);
    expect(msgs[1]).toEqual({ role: 'assistant', content: 'sudah\n[generated file: chart.png]' });
  });
});
