/**
 * Scripted agent: what the fake Qoder does after a `user.message`.
 *
 * Triggers (in the user text):
 *   [[history]]  reply also lists previous user texts of the session joined by " | "
 *   [[doc]]      Bash tool call; reply lists "<mount_path>: <first line>" for each mounted resource
 *   [[image]]    ImageGen + DeliverArtifacts → PNG artifact (needs ImageGen tool; also for agents named qr-image*)
 *   [[video]]    VideoGen + DeliverArtifacts → MP4 artifact (needs VideoGen tool; also for agents named qr-video*)
 *   [[error]]    session.error (api_error "mock failure") + session.status_terminated
 *   [[slow]]     waits 1 s before replying (handy for interrupt tests)
 * Parameters: size=WxH (image), seconds=N, ratio=R, resolution=P (video).
 */
import {
  type MockCore,
  MODEL_UNAVAILABLE,
  type QoderEvent,
  roundCredits,
  type SessionRecord,
  type Subscriber,
} from './core.js';
import { makeMp4, makePng } from './media.js';

export interface ScriptOptions {
  deltaChunkSize: number;
  videoDelayMs: number;
  imageDelayMs: number;
  slowDelayMs: number;
  /** Test hook: return a string to replace the scripted reply text (undefined = default behaviour). */
  reply?: (text: string, modelId: string) => string | undefined;
  /** Test hook: files to deliver with DeliverArtifacts for a turn (e.g. sandbox-made audio). */
  files?: (text: string) => { name: string; bytes: Buffer; mimeType: string }[] | undefined;
  /** Test hook: return an error text to make the ImageGen/VideoGen call fail (no artifact), like upstream throttling. */
  toolError?: (tool: 'ImageGen' | 'VideoGen', text: string) => string | undefined;
}

export const CREDITS = { turn: 0.01, image: 0.05, video: 0.2 } as const;

class Interrupted extends Error {}

/** setTimeout that rejects with `Interrupted` when the turn is interrupted. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Interrupted());
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Interrupted());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const tick = () => new Promise<void>((r) => setImmediate(r));

type ContentBlock = { type: string; text?: string };

export function userText(content: ContentBlock[]): string {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

/** Removes trigger markers and key=value params, leaving the "prompt". */
function cleanPrompt(text: string): string {
  return text
    .replace(/\[\[[a-z]+\]\]/g, ' ')
    .replace(/\b(size|seconds|ratio|resolution)=\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slug(prompt: string, fallback: string): string {
  const s = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 3)
    .join('-');
  return s || fallback;
}

const param = (text: string, key: string, re: string): string | undefined =>
  new RegExp(`\\b${key}=(${re})`).exec(text)?.[1];

/** Subscribers that asked for delta frames of `type`. */
function deltaSubs(s: SessionRecord, type: string): Subscriber[] {
  return [...s.subscribers].filter((sub) => sub.deltas.has(type));
}

export class TurnScript {
  constructor(
    private readonly core: MockCore,
    private readonly opts: ScriptOptions,
  ) {}

  /** Runs one turn for `userEvent` (already buffered). Resolves when the session is idle/terminated again. */
  async run(s: SessionRecord, userEvent: QoderEvent, signal: AbortSignal): Promise<void> {
    const core = this.core;
    const emit = (type: string, fields?: Record<string, unknown>) => core.appendEvent(s, type, fields);
    const content = (userEvent.content ?? []) as ContentBlock[];
    const text = userText(content);
    const n = s.userTexts.length; // the current message is already counted
    const modelId = s.agent.model.id;

    await tick(); // let the POST /events response go out first
    emit('session.status_running');
    emit('session.thread_status_running');

    // Snapshot model retired since session creation → upstream rejects the turn.
    if (!core.activeModel(modelId)) {
      emit('session.error', { error: { type: 'invalid_request_error', message: MODEL_UNAVAILABLE } });
      return this.finish(s, 'end_turn');
    }

    if (text.includes('[[error]]')) {
      emit('session.error', { error: { type: 'api_error', message: 'mock failure' } });
      s.status = 'terminated';
      emit('session.status_terminated');
      return;
    }

    const max = s.budget ? Number(s.budget.max_credit_cost) : Infinity;
    if (s.credits >= max) return this.finish(s, 'budget_exceeded');

    let credits = CREDITS.turn;
    let stop: 'end_turn' | 'interrupted' = 'end_turn';
    try {
      emit('span.model_request_start');
      this.emitThinking(s);
      if (text.includes('[[slow]]')) await sleep(this.opts.slowDelayMs, signal);

      const images = content.filter((b) => b.type === 'image').length;
      let reply = `[${modelId}] Echo #${n}: ${text}`;
      if (images > 0) reply += ` (saw ${images} image(s))`;
      const custom = this.opts.reply?.(text, modelId);
      if (custom !== undefined) reply = custom;

      for (const f of this.opts.files?.(text) ?? []) this.deliver(s, `/tmp/${f.name}`, f.name, f.bytes, f.mimeType);

      if (text.includes('[[history]]')) {
        reply += `\nHistory: ${s.userTexts.slice(0, -1).join(' | ')}`;
      }

      if (text.includes('[[doc]]')) {
        const lines = s.resources.map((r) => {
          const file = core.state.files.get(r.file_id);
          const first = file ? (file.bytes.toString('utf8').split(/\r?\n/)[0] ?? '') : '';
          return `${r.mount_path}: ${first}`;
        });
        const use = emit('agent.tool_use', {
          name: 'Bash',
          input: { command: `head -n 1 ${s.resources.map((r) => r.mount_path).join(' ')}`.trim() },
          evaluated_permission: 'allow',
        });
        emit('agent.tool_result', {
          tool_use_id: use.id,
          is_error: false,
          content: [{ type: 'text', text: lines.join('\n') || 'no files mounted' }],
        });
        if (lines.length) reply += `\n${lines.join('\n')}`;
      }

      const tools = core.enabledTools(s.agent.tools);
      const prompt = cleanPrompt(text);
      const wantsImage = text.includes('[[image]]') || s.agent.name.startsWith('qr-image');
      const wantsVideo = text.includes('[[video]]') || s.agent.name.startsWith('qr-video');

      if (wantsImage && tools.has('ImageGen')) {
        const name = slug(prompt, 'image');
        const size = param(text, 'size', '\\d+x\\d+') ?? '1024x1024';
        const path = `/data/vibe_images/${name}.png`;
        const use = emit('agent.tool_use', {
          name: 'ImageGen',
          input: { name, prompt, size },
          evaluated_permission: 'allow',
        });
        await sleep(this.opts.imageDelayMs, signal);
        const imageFailure = this.opts.toolError?.('ImageGen', text);
        if (imageFailure !== undefined) {
          emit('agent.tool_result', { tool_use_id: use.id, is_error: true, content: [{ type: 'text', text: imageFailure }] });
          reply += '\nImage generation failed.';
        } else {
          credits += CREDITS.image;
          emit('agent.tool_result', {
            tool_use_id: use.id,
            is_error: false,
            content: [{ type: 'text', text: `Image generated successfully! The absolute path of the image is: ${path}` }],
          });
          this.deliver(s, path, `${name}.png`, makePng(), 'image/png');
          reply += `\nDelivered ${name}.png`;
        }
      }

      if (wantsVideo && tools.has('VideoGen')) {
        const name = slug(prompt, 'video');
        const duration = Number(param(text, 'seconds', '-?\\d+') ?? 5);
        const resolution = param(text, 'resolution', '\\w+') ?? '1080P';
        const ratio = param(text, 'ratio', '[\\w:]+') ?? '16:9';
        const path = `/data/vibe_videos/${name}.mp4`;
        const use = emit('agent.tool_use', {
          name: 'VideoGen',
          input: { name, prompt, mode: 'text_to_video', duration_seconds: duration, resolution, ratio, audio: true },
          evaluated_permission: 'allow',
        });
        await sleep(this.opts.videoDelayMs, signal);
        const videoFailure = this.opts.toolError?.('VideoGen', text);
        if (videoFailure !== undefined) {
          emit('agent.tool_result', { tool_use_id: use.id, is_error: true, content: [{ type: 'text', text: videoFailure }] });
          reply += '\nVideo generation failed.';
        } else {
          credits += CREDITS.video;
          const bytes = makeMp4();
          emit('agent.tool_result', {
            tool_use_id: use.id,
            is_error: false,
            content: [
              {
                type: 'text',
                text:
                  `Video generated successfully! The absolute path of the video is: ${path}\n` +
                  `Video ID: ${core.nextId('vid')}\nduration: ${duration}s, resolution: ${resolution}, ratio: ${ratio}, bytes: ${bytes.length}`,
              },
            ],
          });
          this.deliver(s, path, `${name}.mp4`, bytes, 'video/mp4');
          reply += `\nDelivered ${name}.mp4`;
        }
      }

      emit('span.model_request_end', { is_error: false, model_usage: { credits: roundCredits(credits) } });
      await this.emitMessage(s, reply);
    } catch (err) {
      if (!(err instanceof Interrupted)) throw err;
      stop = 'interrupted';
    }

    s.credits = roundCredits(s.credits + credits);
    const exceeded = stop === 'end_turn' && s.credits > max;
    return this.finish(s, exceeded ? 'budget_exceeded' : stop);
  }

  /** thread idle → session.usage → session idle. */
  private finish(s: SessionRecord, stop: string): void {
    const stopReason = { type: stop };
    this.core.appendEvent(s, 'session.thread_status_idle', { stop_reason: stopReason });
    // Credits are cumulative for the whole session (the real payload doesn't tell; see index.ts header).
    this.core.appendEvent(s, 'session.usage', {
      model_credits: roundCredits(s.credits),
      sandbox_runtime_credits: 0,
      total_credits: roundCredits(s.credits),
    });
    s.status = 'idle';
    this.core.appendEvent(s, 'session.status_idle', { stop_reason: stopReason });
  }

  /** DeliverArtifacts tool call + artifact_delivered with a fresh downloadable file. */
  private deliver(s: SessionRecord, path: string, filename: string, bytes: Buffer, contentType: string): void {
    const core = this.core;
    const use = core.appendEvent(s, 'agent.tool_use', {
      name: 'DeliverArtifacts',
      input: { paths: [path] },
      evaluated_permission: 'allow',
    });
    const file = core.createFile({
      filename,
      bytes,
      mimeType: contentType,
      downloadable: true,
      scope: { id: s.id, type: 'session' },
    });
    core.appendEvent(s, 'agent.artifact_delivered', {
      file_id: file.id,
      original_filename: filename,
      size: bytes.length,
      content_type: contentType,
    });
    core.appendEvent(s, 'agent.tool_result', {
      tool_use_id: use.id,
      is_error: false,
      content: [{ type: 'text', text: `Delivered 1 artifact(s): ${filename}` }],
    });
  }

  /** agent.thinking; streams that requested any deltas get an `event_start` for it first (like the real API). */
  private emitThinking(s: SessionRecord): void {
    const id = this.core.nextId('evt');
    const subs = [...s.subscribers].filter((sub) => sub.deltas.size > 0);
    this.core.sendTransient(subs, id, 'event_start', { event: { id, type: 'agent.thinking' }, type: 'event_start' });
    this.core.appendEvent(s, 'agent.thinking', {}, id);
  }

  /** event_start + event_delta chunks (for delta subscribers), then the buffered agent.message under the same id. */
  private async emitMessage(s: SessionRecord, text: string): Promise<void> {
    const core = this.core;
    const id = core.nextId('evt');
    const subs = deltaSubs(s, 'agent.message'); // snapshot: late joiners only get the buffered event
    if (subs.length) {
      core.sendTransient(subs, id, 'event_start', { event: { id, type: 'agent.message' }, type: 'event_start' });
      const size = Math.max(1, this.opts.deltaChunkSize);
      for (let i = 0; i < text.length; i += size) {
        core.sendTransient(subs, id, 'event_delta', {
          delta: { content: { text: text.slice(i, i + size), type: 'text' }, index: 0, type: 'content_delta' },
          event_id: id,
          type: 'event_delta',
        });
        await tick();
      }
    }
    core.appendEvent(s, 'agent.message', { content: [{ type: 'text', text }] }, id);
  }
}
