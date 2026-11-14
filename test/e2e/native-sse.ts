/** Test helpers for SSE responses of the native API. */

export interface SseFrame {
  id?: string;
  event: string;
  data: any;
}

export function parseSseText(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let id: string | undefined;
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length) frames.push({ id, event, data: JSON.parse(data.join('\n')) });
  }
  return frames;
}

/** Read the whole SSE body (the server closes it at the end of the turn/job). */
export async function readSse(res: Response): Promise<SseFrame[]> {
  return parseSseText(await res.text());
}

/** Read frames until `stop(frame)` is true, then cancel the body (simulates a client disconnect). */
export async function readSseUntil(res: Response, stop: (f: SseFrame) => boolean): Promise<SseFrame[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const out: SseFrame[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return out;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split(/\n\n/);
    buf = parts.pop() ?? '';
    for (const f of parseSseText(parts.join('\n\n'))) {
      out.push(f);
      if (stop(f)) {
        await reader.cancel();
        return out;
      }
    }
  }
}
