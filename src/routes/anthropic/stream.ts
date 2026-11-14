import { estimateTokens } from '../../core/compat.js';
import type { TurnEvent } from '../../core/events.js';
import { artifactMarkdown, toAnthropicStop } from './convert.js';

/** Keep-alive interval while the agent thinks or runs tools (proxies drop idle connections). */
const PING_MS = 15_000;

type Send = (event: string, data: Record<string, unknown>) => void;

export interface StreamOptions {
  /** Turn events after `turn.started`. */
  events: AsyncIterable<TurnEvent>;
  messageId: string;
  model: string;
  inputTokens: number;
  /** Called when the client goes away: stop iterating, but let the turn finish. */
  onDisconnect: () => void;
}

/** Renders a running turn as the Anthropic Messages SSE sequence. */
export function anthropicSse(o: StreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let closed = false;
  let timer: NodeJS.Timeout | undefined;

  const stop = () => {
    closed = true;
    clearInterval(timer);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send: Send = (event, data) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`));
        } catch {
          stop();
        }
      };
      timer = setInterval(() => send('ping', {}), PING_MS);
      void writeTurn(send, o)
        .catch((err: unknown) => send('error', apiError(err instanceof Error ? err.message : String(err))))
        .finally(() => {
          if (closed) return;
          stop();
          controller.close();
        });
    },
    cancel() {
      stop();
      o.onDisconnect();
    },
  });
}

const apiError = (message: string) => ({ error: { type: 'api_error', message } });

async function writeTurn(send: Send, o: StreamOptions): Promise<void> {
  send('message_start', {
    message: {
      id: o.messageId,
      type: 'message',
      role: 'assistant',
      model: o.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: o.inputTokens, output_tokens: 0 },
    },
  });
  send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  send('ping', {});

  const delta = (text: string) => send('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  let output = '';

  for await (const e of o.events) {
    if (e.type === 'text.delta') {
      output += e.text;
      delta(e.text);
    } else if (e.type === 'error') {
      send('error', apiError(e.message));
      return;
    } else if (e.type === 'turn.completed') {
      if (e.stopReason === 'error') return send('error', apiError('The turn failed upstream'));
      // Artifacts go last so streamed and non-streamed replies have identical text.
      for (const a of e.artifacts) delta(artifactMarkdown(a));
      send('content_block_stop', { index: 0 });
      send('message_delta', {
        delta: { stop_reason: toAnthropicStop(e.stopReason), stop_sequence: null },
        usage: { output_tokens: estimateTokens(output), stillgpt_credits: e.credits.total },
      });
      send('message_stop', {});
      return;
    }
  }
}
