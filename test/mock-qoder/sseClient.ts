/**
 * Minimal SSE client for tests (fetch-based, so it can send Authorization / Last-Event-ID headers).
 *
 *   const sse = await SseConnection.open(`${qoder.url}/sessions/${id}/events/stream`, { headers: auth });
 *   const frames = await sse.collectUntil((f) => f.event === 'session.status_idle');
 *   sse.close();
 */

export interface SseFrame {
  /** `id:` field of this frame (undefined when the frame had none, e.g. heartbeats). */
  id?: string;
  /** `event:` field; `message` when absent. */
  event: string;
  /** `data:` lines joined with `\n`. */
  data: string;
}

/** Parses `data` as JSON. */
export function frameJson<T = Record<string, unknown>>(frame: SseFrame): T {
  return JSON.parse(frame.data) as T;
}

/** Parses an SSE byte stream into frames (per the WHATWG event-stream rules, minus `retry`). */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buffer = '';
  let id: string | undefined;
  let event: string | undefined;
  let data: string[] = [];
  let sawField = false;

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.search(/\r\n|\r|\n/)) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + (buffer.startsWith('\r\n', nl) ? 2 : 1));
      if (line === '') {
        if (sawField) yield { id, event: event ?? 'message', data: data.join('\n') };
        id = undefined;
        event = undefined;
        data = [];
        sawField = false;
        continue;
      }
      if (line.startsWith(':')) continue; // comment
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      sawField = true;
      if (field === 'id') id = value;
      else if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
  }
}

export class SseTimeoutError extends Error {}

export class SseConnection {
  private pending: Promise<IteratorResult<SseFrame>> | undefined;
  /** Every frame received so far (including heartbeats). */
  readonly received: SseFrame[] = [];

  private constructor(
    readonly response: Response,
    private readonly iterator: AsyncGenerator<SseFrame>,
    private readonly controller: AbortController,
  ) {}

  /** Opens the stream; rejects if the response is not 200 (body text in the message). */
  static async open(url: string, init: { headers?: Record<string, string> } = {}): Promise<SseConnection> {
    const controller = new AbortController();
    const response = await fetch(url, {
      headers: { accept: 'text/event-stream', ...init.headers },
      signal: controller.signal,
    });
    if (response.status !== 200 || !response.body) {
      const text = await response.text().catch(() => '');
      throw new Error(`SSE open failed: ${response.status} ${text}`);
    }
    return new SseConnection(response, parseSse(response.body), controller);
  }

  get status(): number {
    return this.response.status;
  }

  /** Next frame, `null` at end of stream; throws SseTimeoutError after `timeoutMs` (the frame isn't lost). */
  async next(timeoutMs = 5000): Promise<SseFrame | null> {
    this.pending ??= this.iterator.next();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SseTimeoutError(`no SSE frame within ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      const result = await Promise.race([this.pending, timeout]);
      this.pending = undefined;
      if (result.done) return null;
      this.received.push(result.value);
      return result.value;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Reads frames until `pred` matches (inclusive). Throws on timeout or end of stream. */
  async collectUntil(pred: (f: SseFrame) => boolean, timeoutMs = 5000): Promise<SseFrame[]> {
    const deadline = Date.now() + timeoutMs;
    const out: SseFrame[] = [];
    for (;;) {
      const frame = await this.next(Math.max(1, deadline - Date.now()));
      if (!frame) throw new Error(`SSE stream ended before condition matched (got ${out.length} frames)`);
      out.push(frame);
      if (pred(frame)) return out;
    }
  }

  /** Reads frames for `ms` and returns them (no error when none arrive). */
  async collectFor(ms: number): Promise<SseFrame[]> {
    const deadline = Date.now() + ms;
    const out: SseFrame[] = [];
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return out;
      try {
        const frame = await this.next(left);
        if (!frame) return out;
        out.push(frame);
      } catch (err) {
        if (err instanceof SseTimeoutError) return out;
        throw err;
      }
    }
  }

  close(): void {
    this.controller.abort();
    // Swallow the AbortError of any in-flight read.
    this.pending?.catch(() => undefined);
    void this.iterator.return(undefined).catch(() => undefined);
  }
}
