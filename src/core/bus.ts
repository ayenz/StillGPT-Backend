import { EventEmitter } from 'node:events';

/**
 * In-process pub/sub keyed by topic (e.g. `conv:<id>`, `job:<id>`).
 * Turns and jobs run detached from HTTP requests; routes subscribe here to stream progress,
 * so a client disconnect never kills generation. Single-instance by design (see ARCHITECTURE §4).
 */
export class EventBus {
  private readonly emitter = new EventEmitter().setMaxListeners(0);

  publish<T>(topic: string, event: T): void {
    this.emitter.emit(topic, event);
  }

  subscribe<T>(topic: string, fn: (event: T) => void): () => void {
    this.emitter.on(topic, fn);
    return () => this.emitter.off(topic, fn);
  }

  /** Async iterator over a topic until `until(event)` returns true or the signal aborts. */
  async *iterate<T>(topic: string, until: (event: T) => boolean, signal?: AbortSignal): AsyncGenerator<T> {
    const queue: T[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = this.subscribe<T>(topic, (e) => {
      queue.push(e);
      wake?.();
    });
    const onAbort = () => wake?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      while (!signal?.aborted) {
        if (!queue.length) await new Promise<void>((r) => (wake = r));
        wake = undefined;
        while (queue.length) {
          const e = queue.shift()!;
          yield e;
          if (until(e)) return;
        }
      }
    } finally {
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
