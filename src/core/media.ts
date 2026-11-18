import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { type ContentBlock, conversations, files, mediaJobs } from '../db/schema.js';
import type { ImageProvider } from '../config.js';
import { AppError, badRequest, notFound, toAppError } from '../errors.js';
import { newId } from '../ids.js';
import type { Logger } from '../log.js';
import { type FolaxClient, toFolaxRatio } from '../providers/folax.js';
import type { QoderClient } from '../qoder/client.js';
import type { QoderEvent } from '../qoder/types.js';
import { ATTACHMENT_DIR } from './attachments.js';
import type { EventBus } from './bus.js';
import type { ConversationService } from './conversations.js';
import type { PromptEnhancer } from './enhancer.js';
import { type PromptVariator, VARIATION_AXES, type VariationAxis } from './variations.js';
import type { Artifact, Credits, TurnEvent } from './events.js';
import type { MediaStore, StoredFile, UrlScope } from './storage.js';
import type { TurnResult, TurnRunner } from './turns.js';
import type { UsageService } from './usage.js';
import type { WebhookService } from './webhooks.js';

export type MediaJob = typeof mediaJobs.$inferSelect;

export const IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536', '768x1024', '1024x768', '1024x1280', '1280x1024', '1024x1792', '1792x1024', '2560x1080'] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];
/** Most images one `POST /images` may ask for (`n`); each is its own Qoder job, run in parallel. */
export const MAX_IMAGE_BATCH = 6;
export const VIDEO_RATIOS = ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const;
export type VideoRatio = (typeof VIDEO_RATIOS)[number];
export const VIDEO_RESOLUTIONS = ['480P', '720P', '1080P'] as const;
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];

export interface ImageRequest {
  userId: string;
  prompt: string;
  size?: ImageSize;
  /** Run the prompt enhancer first (default false = use the prompt verbatim). */
  enhance?: boolean;
  /** Our file ids of input images (edit / compose; max 3). */
  inputFileIds?: string[];
  /** Image generator; default from config IMAGE_PROVIDER_DEFAULT. */
  provider?: ImageProvider;
  /**
   * Give each image its own variation of the (enhanced) prompt: outfit, colours, background… change while the
   * subject stays. `true` uses the default axes. Input images count as references to move away from.
   */
  variations?: boolean | { vary?: VariationAxis[]; keep?: VariationAxis[] };
  callbackUrl?: string;
}

export interface VideoRequest {
  userId: string;
  prompt: string;
  /** 2–30, or -1 to let the model decide. Default 5. */
  seconds?: number;
  resolution?: VideoResolution;
  ratio?: VideoRatio;
  audio?: boolean;
  firstFrameFileId?: string;
  lastFrameFileId?: string;
  referenceFileIds?: string[];
  /** Run the prompt enhancer first (default false = use the prompt verbatim). */
  enhance?: boolean;
  callbackUrl?: string;
}

/** Public JSON shape of a job (native API). */
export interface MediaJobView {
  id: string;
  kind: 'image' | 'video';
  status: MediaJob['status'];
  progress: number;
  request: Record<string, unknown>;
  outputs: Artifact[];
  error: { code: string; message: string } | null;
  credits: number | null;
  /** Set when the job was created as part of an image batch (`n`). */
  batch_id: string | null;
  created_at: string;
  completed_at: string | null;
}

/** Aggregate of the jobs of one image batch. `partial` = finished with some (not all) jobs failed. */
export interface ImageBatchView {
  id: string;
  status: 'queued' | 'in_progress' | 'completed' | 'partial' | 'failed';
  /** 0–100, average over the jobs (finished jobs count as 100). */
  progress: number;
  n: number;
  completed: number;
  failed: number;
  credits: number | null;
  jobs: MediaJobView[];
  created_at: string;
  completed_at: string | null;
}

export function batchViewOf(id: string, jobs: MediaJobView[]): ImageBatchView {
  const completed = jobs.filter((j) => j.status === 'completed').length;
  const failed = jobs.filter((j) => j.status === 'failed').length;
  const done = completed + failed === jobs.length;
  const status: ImageBatchView['status'] = !done
    ? jobs.some((j) => j.status !== 'queued')
      ? 'in_progress'
      : 'queued'
    : failed === 0
      ? 'completed'
      : completed === 0
        ? 'failed'
        : 'partial';
  const credited = jobs.filter((j) => j.credits !== null);
  const ends = jobs.map((j) => j.completed_at).filter((x): x is string => !!x);
  return {
    id,
    status,
    progress: Math.round(jobs.reduce((sum, j) => sum + (isTerminal(j.status) ? 100 : j.progress), 0) / Math.max(jobs.length, 1)),
    n: jobs.length,
    completed,
    failed,
    credits: credited.length ? Math.round(credited.reduce((sum, j) => sum + j.credits!, 0) * 10000) / 10000 : null,
    jobs,
    created_at: jobs.map((j) => j.created_at).sort()[0] ?? new Date().toISOString(),
    completed_at: done ? (ends.sort().at(-1) ?? null) : null,
  };
}

/** Published on the bus topic `job:<id>`. */
export type MediaJobEvent =
  | { type: 'progress'; id: string; status: MediaJob['status']; progress: number }
  | { type: 'completed' | 'failed'; job: MediaJobView };

export const jobTopic = (id: string) => `job:${id}`;

/** Wire JSON of a job (native API, SSE, webhooks): like MediaJobView with snake_case output fields. */
export function mediaJobJson(v: MediaJobView) {
  return { ...v, outputs: v.outputs.map((a) => ({
      id: a.id,
      name: a.name,
      mime_type: a.mimeType,
      size: a.size,
      kind: a.kind,
      url: a.url,
      thumbnail_url: a.thumbnailUrl ?? null,
      preview_url: a.previewUrl ?? null,
    })),
  };
}
export type MediaJobJson = ReturnType<typeof mediaJobJson>;
export const imageBatchJson = (b: ImageBatchView) => ({ ...b, jobs: b.jobs.map(mediaJobJson) });
export const isTerminal = (status: MediaJob['status']) => status === 'completed' || status === 'failed';

export interface MediaServiceDeps {
  db: DB;
  qoder: QoderClient;
  conversations: ConversationService;
  turns: TurnRunner;
  store: MediaStore;
  usage: UsageService;
  webhooks: WebhookService;
  bus: EventBus;
  log: Logger;
  enhancer: PromptEnhancer;
  /** Needed for `variations` on image requests. */
  variator?: PromptVariator;
  /** null when Folax is not configured. */
  folax: FolaxClient | null;
  defaultImageProvider: ImageProvider;
  videoConcurrency: number;
  /** Progress ticks and restart-recovery polling. Default 5 s. */
  pollIntervalMs?: number;
  /** Waits before re-submitting a job that Qoder rejected with a full generation queue. Default 30 s, 1, 2, 3, 5 min. */
  queueRetryDelaysMs?: number[];
}

const DEFAULT_QUEUE_RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 180_000, 300_000];
/** Upstream generator throttling, e.g. `Throttling.QueueQuota … Task queue limit exceeded` (HTTP 429). */
const QUEUE_FULL = /QueueQuota|queue limit|Throttling|status=429|HTTP 429/i;
const GENERATOR_TOOLS = new Set(['ImageGen', 'VideoGen']);

/** Typical wall-clock durations, used only to estimate progress. */
const EXPECTED_MS = { image: 30_000, video: 210_000, folax: 12_000 } as const;
const MAX_RECOVERY_MS = 45 * 60_000;
/** At most one `provider.degraded` webhook per provider per hour. */
const DEGRADED_THROTTLE_MS = 3600_000;
const PROMPT_MAX = 4000;

// ── validation ─────────────────────────────────────────────────────────────

const fileIds = (max: number, what: string) => z.array(z.string().min(1)).max(max, `at most ${max} ${what}`);

const imageSchema = z.object({
  userId: z.string().min(1),
  prompt: z.string().trim().min(1, 'prompt is required').max(PROMPT_MAX),
  size: z.enum(IMAGE_SIZES).optional(),
  enhance: z.boolean().default(false),
  inputFileIds: fileIds(3, 'input images').default([]),
  provider: z.enum(['auto', 'qoder', 'folax']).optional(),
  variations: z
    .union([z.boolean(), z.object({ vary: z.array(z.enum(VARIATION_AXES)).min(1).optional(), keep: z.array(z.enum(VARIATION_AXES)).optional() }).strict()])
    .optional(),
  callbackUrl: z.url({ protocol: /^https?$/ }).optional(),
});

const videoSchema = z
  .object({
    userId: z.string().min(1),
    prompt: z.string().trim().min(1, 'prompt is required').max(PROMPT_MAX),
    seconds: z
      .number()
      .int()
      .refine((n) => n === -1 || (n >= 2 && n <= 30), 'seconds must be between 2 and 30, or -1')
      .optional(),
    resolution: z.enum(VIDEO_RESOLUTIONS).default('1080P'),
    ratio: z.enum(VIDEO_RATIOS).optional(),
    audio: z.boolean().default(true),
    firstFrameFileId: z.string().min(1).optional(),
    lastFrameFileId: z.string().min(1).optional(),
    referenceFileIds: fileIds(10, 'reference images').default([]),
    enhance: z.boolean().default(false),
    callbackUrl: z.url({ protocol: /^https?$/ }).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.lastFrameFileId && !v.firstFrameFileId) ctx.addIssue({ code: 'custom', path: ['lastFrameFileId'], message: 'last frame requires a first frame' });
    if (v.referenceFileIds.length && v.firstFrameFileId)
      ctx.addIssue({ code: 'custom', path: ['referenceFileIds'], message: 'reference images cannot be combined with first/last frames' });
  });

type ValidImage = z.infer<typeof imageSchema>;
type ValidVideo = z.infer<typeof videoSchema>;

function validate<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => ({ path: i.path.map((p) => snake(String(p))).join('.'), message: i.message }));
  throw badRequest(issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; '), 'validation_error', { issues });
}

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

// ── service ────────────────────────────────────────────────────────────────

interface JobInput {
  file: StoredFile;
  /** Path the file gets inside the sandbox (mirrors prepareInput's mount naming). */
  path: string;
}

/**
 * Image and video generation as jobs. Each job runs one turn on a hidden one-shot conversation
 * (profile `image`/`video`) through the TurnRunner; inputs are mounted as documents under /data/attachments/.
 * Text-to-image jobs can instead go to Folax (no Qoder turn; `auto` falls back to Qoder when Folax fails).
 * Videos go through a small queue (`videoConcurrency`); jobs interrupted by a restart are finished by
 * reading the upstream session events.
 */
export class MediaService {
  private readonly pollMs: number;
  private readonly queue: string[] = [];
  private readonly runningVideos = new Set<string>();
  /** Jobs being run or resumed by this process (so a second start() does not pick them up twice). */
  private readonly active = new Set<string>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly degradedAt = new Map<string, number>();
  private stopped = false;

  constructor(private readonly d: MediaServiceDeps) {
    this.pollMs = d.pollIntervalMs ?? 5000;
  }

  /** Synchronous image generation (~30 s). Resolves when the job finished (completed or failed). */
  async generateImage(req: ImageRequest): Promise<MediaJobView> {
    const job = await this.createImage(req);
    await this.run(job);
    return this.getJob(job.id, req.userId);
  }

  async createImageJob(req: ImageRequest): Promise<MediaJobView> {
    const job = await this.createImage(req);
    void this.run(job);
    return this.view(job);
  }

  /**
   * `n` images of one prompt as `n` parallel jobs sharing a batch id. The prompt is enhanced once for all of them.
   * n > 1 always runs on Qoder (one image per job); n = 1 follows the normal provider routing.
   * `wait` resolves once every job finished (synchronous APIs); otherwise right after the jobs started.
   */
  async createImageBatch(req: ImageRequest, n: number, opts: { wait?: boolean } = {}): Promise<ImageBatchView> {
    if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGE_BATCH) throw badRequest(`n must be an integer between 1 and ${MAX_IMAGE_BATCH}`, 'validation_error', { param: 'n' });
    if (n > 1 && req.provider === 'folax') throw badRequest('n > 1 is only supported by the qoder provider', 'validation_error', { param: 'provider' });
    const { v, request } = await this.prepareImage(n > 1 ? { ...req, provider: 'qoder' } : req);
    const variants = await this.variantsFor(v, request, n);
    const batchId = newId('batch');
    const rows = await this.d.db
      .insert(mediaJobs)
      .values(
        Array.from({ length: n }, (_, i) => ({
          id: newId('img'),
          userId: v.userId,
          kind: 'image' as const,
          request: { ...request, ...variants[i], n, batch_index: i },
          callbackUrl: v.callbackUrl ?? null,
          batchId,
        })),
      )
      .returning();
    const runs = rows.map((job) => this.run(job));
    if (opts.wait) await Promise.all(runs);
    return this.getBatch(batchId, v.userId);
  }

  async getBatch(id: string, userId: string): Promise<ImageBatchView> {
    const rows = await this.d.db
      .select()
      .from(mediaJobs)
      .where(and(eq(mediaJobs.batchId, id), eq(mediaJobs.userId, userId), isNull(mediaJobs.deletedAt)));
    if (!rows.length) throw notFound('Batch');
    rows.sort((a, b) => Number(a.request.batch_index ?? 0) - Number(b.request.batch_index ?? 0));
    return batchViewOf(id, await Promise.all(rows.map((r) => this.view(r))));
  }

  async createVideoJob(req: VideoRequest): Promise<MediaJobView> {
    const v = validate(videoSchema, req);
    await this.d.usage.assertWithinLimit(v.userId);
    const frames = [v.firstFrameFileId, v.lastFrameFileId, ...v.referenceFileIds].filter((x): x is string => !!x);
    await this.loadInputs(v.userId, frames);
    const mode = v.firstFrameFileId ? 'first_frame_to_video' : v.referenceFileIds.length ? 'reference_to_video' : 'text_to_video';
    const e = v.enhance ? await this.d.enhancer.enhance({ userId: v.userId, prompt: v.prompt, kind: 'video' }) : null;
    const request = {
      prompt: e?.prompt ?? v.prompt,
      ...(e ? { original_prompt: v.prompt } : {}),
      enhance: v.enhance,
      mode,
      seconds: v.seconds ?? e?.seconds ?? 5,
      resolution: v.resolution,
      // with frames/references the input image decides the shape, so the enhancer's ratio only applies to text_to_video
      ratio: v.ratio ?? (mode === 'text_to_video' ? (e?.ratio ?? '16:9') : 'adaptive'),
      audio: v.audio,
      first_frame_file_id: v.firstFrameFileId ?? null,
      last_frame_file_id: v.lastFrameFileId ?? null,
      reference_file_ids: v.referenceFileIds,
    };
    const job = await this.insertJob(v.userId, 'video', request, v.callbackUrl);
    this.enqueue(job.id);
    return this.view(job);
  }

  async getJob(id: string, userId: string): Promise<MediaJobView> {
    return this.view(await this.getRow(id, userId));
  }

  async listJobs(userId: string, opts: { kind?: 'image' | 'video'; batchId?: string; limit?: number } = {}): Promise<MediaJobView[]> {
    const conds = [eq(mediaJobs.userId, userId), isNull(mediaJobs.deletedAt)];
    if (opts.kind) conds.push(eq(mediaJobs.kind, opts.kind));
    if (opts.batchId) conds.push(eq(mediaJobs.batchId, opts.batchId));
    const rows = await this.d.db
      .select()
      .from(mediaJobs)
      .where(and(...conds))
      .orderBy(desc(mediaJobs.createdAt))
      .limit(Math.min(Math.max(opts.limit ?? 20, 1), 100));
    return Promise.all(rows.map((r) => this.view(r)));
  }

  /** The stored file of a job's first output (used to stream video content). */
  async outputFile(id: string, userId: string): Promise<StoredFile> {
    const job = await this.getRow(id, userId);
    const fileId = job.resultFileIds[0];
    if (job.status !== 'completed' || !fileId) throw new AppError(409, 'job_not_completed', 'The job has no output yet');
    return this.d.store.get(fileId, userId);
  }

  /** Start the background worker; resume jobs left in_progress by a restart. */
  start(): void {
    this.stopped = false;
    void this.resumeAll().catch((err) => this.d.log.error('media.resume_failed', { err }));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers.clear();
    this.queue.length = 0;
  }

  // ── creation ────────────────────────────────────────────────────────────

  private async createImage(req: ImageRequest): Promise<MediaJob> {
    const { v, request } = await this.prepareImage(req);
    const [variant] = await this.variantsFor(v, request, 1);
    return this.insertJob(v.userId, 'image', { ...request, ...variant }, v.callbackUrl);
  }

  /**
   * Per-image request overrides for `variations`: a varied `prompt` plus `base_prompt` and `variation` (what changed).
   * Variations are a nice-to-have, so a failure falls back to the same prompt for every image instead of failing the request.
   */
  private async variantsFor(v: ValidImage, request: Record<string, unknown>, n: number): Promise<Record<string, unknown>[]> {
    const none = Array.from({ length: n }, () => ({}));
    if (!v.variations) return none;
    if (!this.d.variator) throw badRequest('Prompt variations are not available', 'validation_error', { param: 'variations' });
    const axes = typeof v.variations === 'object' ? v.variations : {};
    const base = String(request.prompt);
    try {
      const r = await this.d.variator.vary({ userId: v.userId, prompt: base, referenceFileIds: v.inputFileIds, vary: axes.vary, keep: axes.keep, n });
      // fewer usable variations than images: the remaining images reuse them round-robin
      return none.map((_, i) => {
        const x = r.variations[i % r.variations.length]!;
        return { prompt: x.prompt, base_prompt: base, variation: { changed: x.changed, vary: r.vary, keep: r.keep } };
      });
    } catch (err) {
      if (err instanceof AppError && err.status < 500) throw err;
      this.d.log.warn('media.variations_failed', { err });
      return none;
    }
  }

  /** Validate, check limits and inputs, pick the provider and run the enhancer: the stored `request` of an image job. */
  private async prepareImage(req: ImageRequest): Promise<{ v: ValidImage; request: Record<string, unknown> }> {
    const v: ValidImage = validate(imageSchema, req);
    await this.d.usage.assertWithinLimit(v.userId);
    await this.loadInputs(v.userId, v.inputFileIds);
    const provider = v.provider ?? this.d.defaultImageProvider;
    const providerUsed = this.imageProviderFor(v.provider, provider, v.inputFileIds.length > 0);
    const e = v.enhance ? await this.d.enhancer.enhance({ userId: v.userId, prompt: v.prompt, kind: 'image' }) : null;
    const request = {
      prompt: e?.prompt ?? v.prompt,
      ...(e ? { original_prompt: v.prompt } : {}),
      size: v.size ?? e?.size ?? '1024x1024',
      enhance: v.enhance,
      input_file_ids: v.inputFileIds,
      provider,
      provider_used: providerUsed,
    };
    return { v, request };
  }

  /** Folax only does text-to-image and only when configured; edits always go to Qoder ImageGen. */
  private imageProviderFor(explicit: ImageProvider | undefined, provider: ImageProvider, hasInputs: boolean): 'qoder' | 'folax' {
    if (explicit === 'folax' && !this.d.folax) throw badRequest('The folax image provider is not configured', 'provider_unavailable', { param: 'provider' });
    if (explicit === 'folax' && hasInputs) throw badRequest('provider folax cannot edit images; use qoder (or auto) with input images', 'validation_error', { param: 'provider' });
    return provider !== 'qoder' && !hasInputs && this.d.folax ? 'folax' : 'qoder';
  }

  private async insertJob(userId: string, kind: 'image' | 'video', request: Record<string, unknown>, callbackUrl?: string) {
    const [row] = await this.d.db
      .insert(mediaJobs)
      .values({ id: newId(kind === 'image' ? 'img' : 'vid'), userId, kind, request, callbackUrl: callbackUrl ?? null })
      .returning();
    return row!;
  }

  /** Input files must belong to the user and be images; returns them with their sandbox paths. */
  private async loadInputs(userId: string, ids: string[]): Promise<JobInput[]> {
    const used = new Set<string>();
    const out: JobInput[] = [];
    for (const id of ids) {
      const file = await this.d.store.get(id, userId).catch(() => {
        throw new AppError(404, 'file_not_found', `File ${id} not found`);
      });
      if (!file.mimeType.startsWith('image/')) throw badRequest(`File ${id} is not an image (${file.mimeType})`, 'validation_error');
      out.push({ file, path: uniquePath(`${ATTACHMENT_DIR}/${file.filename}`, used) });
    }
    return out;
  }

  // ── running ─────────────────────────────────────────────────────────────

  private enqueue(jobId: string) {
    if (!this.queue.includes(jobId)) this.queue.push(jobId);
    this.pump();
  }

  private pump() {
    while (!this.stopped && this.runningVideos.size < this.d.videoConcurrency && this.queue.length) {
      const id = this.queue.shift()!;
      this.runningVideos.add(id);
      void this.runQueued(id).finally(() => {
        this.runningVideos.delete(id);
        this.pump();
      });
    }
  }

  private async runQueued(id: string) {
    const [job] = await this.d.db.select().from(mediaJobs).where(eq(mediaJobs.id, id));
    if (job?.status === 'queued') await this.run(job);
  }

  /** Run one job to completion. Never throws: failures end up on the job. */
  private async run(job: MediaJob): Promise<void> {
    const log = this.d.log.child({ jobId: job.id });
    let stopProgress = () => {};
    this.active.add(job.id);
    try {
      const started = new Date();
      await this.d.db.update(mediaJobs).set({ status: 'in_progress', startedAt: started, progress: 0 }).where(eq(mediaJobs.id, job.id));
      this.publishProgress(job.id, 'in_progress', 0);
      stopProgress = this.trackProgress(job, started);
      let current = job;
      if (usesFolax(job)) {
        try {
          return await this.finish(job.id, await this.runFolax(job));
        } catch (err) {
          current = await this.fallBackFromFolax(job, toAppError(err));
        }
      }
      await this.finish(job.id, await this.runQoderWithRetry(current));
    } catch (err) {
      const e = toAppError(err);
      log.error('media.job_failed', { code: e.code, err: e.message });
      await this.finish(job.id, { fileIds: [], credits: null, error: { code: e.code, message: e.message } }).catch((e2) =>
        log.error('media.finish_failed', { err: e2 }),
      );
    } finally {
      stopProgress();
      this.active.delete(job.id);
    }
  }

  /** One turn on a hidden one-shot conversation with the `image`/`video` profile. */
  private async runQoder(job: MediaJob): Promise<Outcome> {
    const inputs = await this.loadInputs(job.userId, inputIds(job));
    const conv = await this.d.conversations.create({
      userId: job.userId,
      profile: job.kind,
      model: 'default',
      title: `${job.kind}: ${String(job.request.prompt).slice(0, 60)}`,
      metadata: { hidden: true, job_id: job.id },
    });
    const content: ContentBlock[] = [
      { type: 'text', text: job.kind === 'image' ? imageInstruction(job.request, inputs) : videoInstruction(job.request, inputs) },
      ...inputs.map((i): ContentBlock => ({ type: 'document', fileId: i.file.id, filename: i.file.filename, mimeType: i.file.mimeType })),
    ];
    const handle = await this.d.turns.start({ conversationId: conv.id, userId: job.userId, content, kind: job.kind, jobId: job.id, oneShot: true });
    void this.recordSession(job.id, conv.id, handle.iterate());
    const result = await handle.done;
    return outcomeOf(result, generatorErrors(handle.events));
  }

  /**
   * Qoder turn with automatic re-submission while the upstream generation queue is full
   * (the account only gets a few concurrent generations; a long-running job elsewhere blocks new ones).
   */
  private async runQoderWithRetry(job: MediaJob): Promise<Outcome> {
    const delays = this.d.queueRetryDelaysMs ?? DEFAULT_QUEUE_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      const outcome = await this.runQoder(job);
      if (outcome.error?.code !== 'upstream_queue_full' || attempt >= delays.length || this.stopped) return outcome;
      this.d.log.warn('media.queue_full_retry', { jobId: job.id, attempt: attempt + 1, waitMs: delays[attempt] });
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }

  /** Folax returns several images per prompt; all of them become outputs. Free (0 credits). */
  private async runFolax(job: MediaJob): Promise<Outcome> {
    if (!this.d.folax) throw new AppError(503, 'provider_unavailable', 'The folax image provider is not configured');
    const images = await this.d.folax.generate(String(job.request.prompt), toFolaxRatio(String(job.request.size)));
    const fileIds: string[] = [];
    for (const img of images) {
      const file = await this.d.store.save({ userId: job.userId, kind: 'artifact', filename: img.filename, mimeType: img.mimeType, bytes: img.bytes, jobId: job.id });
      fileIds.push(file.id);
    }
    await this.d.usage.record({ userId: job.userId, kind: 'image', model: 'folax', jobId: job.id, credits: { model: 0, sandbox: 0, total: 0 }, free: true });
    return { fileIds, credits: 0, error: null };
  }

  /** Folax failed: tell admins about auth problems; `auto` jobs continue on Qoder, explicit `folax` jobs fail. */
  private async fallBackFromFolax(job: MediaJob, err: AppError): Promise<MediaJob> {
    this.d.log.warn('media.folax_failed', { jobId: job.id, code: err.code, err: err.message });
    if (err.code === 'folax_auth_invalid') this.reportDegraded('folax', err);
    if (job.request.provider !== 'auto') throw err;
    const request = { ...job.request, provider_used: 'qoder', fallback_reason: err.code };
    const [row] = await this.d.db.update(mediaJobs).set({ request }).where(eq(mediaJobs.id, job.id)).returning();
    return row ?? { ...job, request };
  }

  private reportDegraded(provider: string, err: AppError) {
    const last = this.degradedAt.get(provider);
    if (last !== undefined && Date.now() - last < DEGRADED_THROTTLE_MS) return;
    this.degradedAt.set(provider, Date.now());
    void this.d.webhooks
      .emit(null, 'provider.degraded', { provider, code: err.code, message: err.message })
      .catch((e) => this.d.log.error('media.webhook_failed', { err: e }));
  }

  /** Remember the upstream session id as soon as the turn has one (needed for restart recovery). */
  private async recordSession(jobId: string, conversationId: string, events: AsyncIterable<{ type: string }>) {
    for await (const e of events) {
      if (e.type !== 'turn.started') continue;
      const conv = await this.d.conversations.get(conversationId).catch(() => null);
      if (conv?.qoderSessionId) await this.d.db.update(mediaJobs).set({ qoderSessionId: conv.qoderSessionId }).where(eq(mediaJobs.id, jobId)).catch(() => {});
      return;
    }
  }

  /** Time-based progress estimate (upstream reports none), capped at 95 until the job is done. */
  private trackProgress(job: MediaJob, startedAt: Date): () => void {
    const base = usesFolax(job) ? EXPECTED_MS.folax : EXPECTED_MS[job.kind];
    const expected = base * (job.kind === 'video' ? Math.max(1, Number(job.request.seconds) / 5) ** 0.5 : 1);
    let last = 0;
    const timer = setInterval(() => {
      const progress = Math.min(95, Math.floor(((Date.now() - startedAt.getTime()) / expected) * 100));
      if (progress <= last) return;
      last = progress;
      void this.d.db
        .update(mediaJobs)
        .set({ progress })
        .where(and(eq(mediaJobs.id, job.id), eq(mediaJobs.status, 'in_progress')))
        .then(() => this.publishProgress(job.id, 'in_progress', progress))
        .catch(() => {});
    }, this.pollMs);
    timer.unref();
    this.timers.add(timer);
    return () => {
      clearInterval(timer);
      this.timers.delete(timer);
    };
  }

  /** Terminal transition (exactly once): persist, publish, fire webhooks + callback_url. */
  private async finish(jobId: string, o: Outcome) {
    const failed = !!o.error || !o.fileIds.length;
    const error = o.error ?? (failed ? { code: 'no_output', message: 'The generator did not deliver any file' } : null);
    const [row] = await this.d.db
      .update(mediaJobs)
      .set({
        status: failed ? 'failed' : 'completed',
        progress: failed ? sql`${mediaJobs.progress}` : 100,
        resultFileIds: o.fileIds,
        credits: o.credits,
        error,
        completedAt: new Date(),
      })
      .where(and(eq(mediaJobs.id, jobId), inArray(mediaJobs.status, ['queued', 'in_progress'])))
      .returning();
    if (!row) return;
    const view = await this.view(row);
    const type = failed ? 'failed' : 'completed';
    this.d.bus.publish<MediaJobEvent>(jobTopic(jobId), { type, job: view });
    const event = `${row.kind}.${type}` as const;
    const data = { job: mediaJobJson(view) };
    await this.d.webhooks.emit(row.userId, event, data).catch((err) => this.d.log.error('media.webhook_failed', { jobId, err }));
    if (row.callbackUrl) await this.d.webhooks.deliverTo(row.callbackUrl, event, data).catch((err) => this.d.log.error('media.callback_failed', { jobId, err }));
  }

  private publishProgress(id: string, status: MediaJob['status'], progress: number) {
    this.d.bus.publish<MediaJobEvent>(jobTopic(id), { type: 'progress', id, status, progress });
  }

  // ── restart recovery ────────────────────────────────────────────────────

  private async resumeAll() {
    const pending = await this.d.db
      .select()
      .from(mediaJobs)
      .where(inArray(mediaJobs.status, ['queued', 'in_progress']))
      .orderBy(mediaJobs.createdAt);
    for (const job of pending) {
      if (this.stopped) return;
      if (this.active.has(job.id) || this.queue.includes(job.id) || this.runningVideos.has(job.id)) continue;
      if (job.status === 'queued') this.schedule(job);
      else void this.resumeInProgress(job);
    }
  }

  private schedule(job: MediaJob) {
    if (job.kind === 'video') this.enqueue(job.id);
    else void this.run(job);
  }

  private async resumeInProgress(job: MediaJob) {
    if (job.kind === 'video') this.runningVideos.add(job.id);
    this.active.add(job.id);
    let requeued: MediaJob | null = null;
    try {
      requeued = await this.resume(job);
    } catch (err) {
      this.d.log.error('media.resume_job_failed', { jobId: job.id, err });
      await this.finish(job.id, { fileIds: [], credits: null, error: { code: 'recovery_failed', message: (err as Error).message } }).catch(() => {});
    } finally {
      this.active.delete(job.id);
      this.runningVideos.delete(job.id);
    }
    if (requeued) this.schedule(requeued);
    else this.pump();
  }

  /**
   * Finish a job whose turn was cut off by a restart: page through the session's events (from the
   * job's cursor) until the session is idle again, saving delivered artifacts on the way.
   */
  private async resume(job: MediaJob): Promise<MediaJob | null> {
    const log = this.d.log.child({ jobId: job.id });
    const conv = await this.hiddenConversation(job.id);
    const sessionId = job.qoderSessionId ?? conv?.qoderSessionId;
    if (!sessionId) {
      log.warn('media.resume_requeue', { reason: 'no session' });
      return this.resetToQueued(job);
    }
    log.info('media.resume', { sessionId });
    const stopProgress = this.trackProgress(job, job.startedAt ?? job.createdAt);
    try {
      const state: ResumeState = { cursor: job.lastEventId, sawMessage: !!job.lastEventId, fileIds: await this.existingOutputs(job.id), credits: null, error: null };
      const deadline = (job.startedAt ?? job.createdAt).getTime() + MAX_RECOVERY_MS;
      while (!this.stopped) {
        const done = await this.readEvents(job, sessionId, conv?.id ?? null, state);
        if (done) break;
        if (!state.sawMessage && (await this.sessionIdle(sessionId))) return this.resetToQueued(job);
        if (Date.now() > deadline) {
          state.error = { code: 'timeout', message: 'The job did not finish in time' };
          break;
        }
        await new Promise((r) => setTimeout(r, this.pollMs));
      }
      if (this.stopped) return null;
      if (state.credits) await this.d.usage.record({ userId: job.userId, kind: job.kind, conversationId: conv?.id, jobId: job.id, credits: state.credits });
      await this.finish(job.id, { fileIds: state.fileIds, credits: state.credits?.total ?? null, error: state.error });
      await this.releaseSession(sessionId, conv?.id ?? null);
      return null;
    } finally {
      stopProgress();
    }
  }

  /** Reads all available events after the cursor; true once the session went idle/terminated. */
  private async readEvents(job: MediaJob, sessionId: string, conversationId: string | null, st: ResumeState): Promise<boolean> {
    for (;;) {
      const page = await this.d.qoder.listEvents(sessionId, { limit: 100, afterId: st.cursor ?? undefined });
      for (const ev of page.data) {
        if (ev.id) st.cursor = ev.id;
        if (await this.applyEvent(job, conversationId, ev, st)) {
          await this.saveCursor(job.id, st.cursor);
          return true;
        }
      }
      await this.saveCursor(job.id, st.cursor);
      if (!page.has_more || !page.data.length) return false;
    }
  }

  private async applyEvent(job: MediaJob, conversationId: string | null, ev: QoderEvent, st: ResumeState): Promise<boolean> {
    switch (ev.type) {
      case 'user.message':
        st.sawMessage = true;
        return false;
      case 'agent.artifact_delivered': {
        const id = await this.saveArtifact(job, conversationId, ev);
        if (!st.fileIds.includes(id)) st.fileIds.push(id);
        return false;
      }
      case 'session.usage':
        st.credits = { model: Number(ev.model_credits ?? 0), sandbox: Number(ev.sandbox_runtime_credits ?? 0), total: Number(ev.total_credits ?? 0) };
        return false;
      case 'session.error': {
        const e = (ev.error ?? {}) as { type?: string; message?: string };
        st.error = { code: e.type ?? 'upstream_error', message: `Qoder: ${e.message ?? 'session error'}` };
        return false;
      }
      case 'session.status_idle':
        return st.sawMessage;
      case 'session.status_terminated':
        st.error ??= { code: 'upstream_terminated', message: 'Qoder terminated the session' };
        return true;
      default:
        return false;
    }
  }

  private async saveArtifact(job: MediaJob, conversationId: string | null, ev: QoderEvent): Promise<string> {
    const qoderFileId = String(ev.file_id);
    const [existing] = await this.d.db
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.jobId, job.id), eq(files.qoderFileId, qoderFileId)));
    if (existing) return existing.id;
    const bytes = await this.d.qoder.downloadFile(qoderFileId);
    const file = await this.d.store.save({
      userId: job.userId,
      kind: 'artifact',
      filename: String(ev.original_filename ?? qoderFileId),
      mimeType: String(ev.content_type ?? 'application/octet-stream'),
      bytes,
      conversationId,
      jobId: job.id,
      qoderFileId,
    });
    return file.id;
  }

  private async existingOutputs(jobId: string): Promise<string[]> {
    const rows = await this.d.db.select({ id: files.id }).from(files).where(and(eq(files.jobId, jobId), eq(files.kind, 'artifact')));
    return rows.map((r) => r.id);
  }

  /** The recovered job is done: its one-shot session is no longer needed upstream. */
  private async releaseSession(sessionId: string, conversationId: string | null) {
    try {
      if (conversationId) await this.d.db.update(conversations).set({ qoderSessionId: null, lastEventId: null }).where(eq(conversations.id, conversationId));
      await this.d.qoder.archiveSession(sessionId);
    } catch (err) {
      this.d.log.warn('media.session_release_failed', { sessionId, err });
    }
  }

  private async sessionIdle(sessionId: string) {
    const s = await this.d.qoder.getSession(sessionId);
    return s.status === 'idle';
  }

  private async saveCursor(jobId: string, cursor: string | null) {
    if (cursor) await this.d.db.update(mediaJobs).set({ lastEventId: cursor }).where(eq(mediaJobs.id, jobId));
  }

  /** The turn never reached Qoder: back to `queued` so it starts over from scratch. */
  private async resetToQueued(job: MediaJob): Promise<MediaJob | null> {
    const [row] = await this.d.db
      .update(mediaJobs)
      .set({ status: 'queued', qoderSessionId: null, lastEventId: null, progress: 0, startedAt: null })
      .where(eq(mediaJobs.id, job.id))
      .returning();
    return row ?? null;
  }

  private async hiddenConversation(jobId: string) {
    const [row] = await this.d.db
      .select()
      .from(conversations)
      .where(sql`${conversations.metadata}->>'job_id' = ${jobId}`)
      .orderBy(desc(conversations.createdAt))
      .limit(1);
    return row ?? null;
  }

  // ── views ───────────────────────────────────────────────────────────────

  /** A user's job; jobs in the trash count as missing. */
  private async getRow(id: string, userId: string): Promise<MediaJob> {
    const [row] = await this.d.db
      .select()
      .from(mediaJobs)
      .where(and(eq(mediaJobs.id, id), eq(mediaJobs.userId, userId), isNull(mediaJobs.deletedAt)));
    if (!row) throw notFound('Job');
    return row;
  }

  /** Public view of a job row (used by the trash too, with trash-scoped output URLs). */
  jobView(job: MediaJob, scope?: UrlScope): Promise<MediaJobView> {
    return this.view(job, scope);
  }

  private async view(job: MediaJob, scope?: UrlScope): Promise<MediaJobView> {
    const outputs = job.resultFileIds.length ? await this.d.db.select().from(files).where(inArray(files.id, job.resultFileIds)) : [];
    const byId = new Map(outputs.map((f) => [f.id, f]));
    return {
      id: job.id,
      kind: job.kind,
      status: job.status,
      progress: job.progress,
      request: job.request,
      outputs: job.resultFileIds.flatMap((id) => (byId.has(id) ? [this.d.store.toArtifact(byId.get(id)!, scope)] : [])),
      error: job.error ?? null,
      credits: job.credits,
      batch_id: job.batchId ?? null,
      created_at: job.createdAt.toISOString(),
      completed_at: job.completedAt?.toISOString() ?? null,
    };
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

interface Outcome {
  fileIds: string[];
  credits: number | null;
  error: { code: string; message: string } | null;
}

interface ResumeState {
  cursor: string | null;
  sawMessage: boolean;
  fileIds: string[];
  credits: Credits | null;
  error: { code: string; message: string } | null;
}

function outcomeOf(r: TurnResult, toolErrors: string[] = []): Outcome {
  const media = r.artifacts.filter((a) => a.kind === 'image' || a.kind === 'video');
  const fileIds = (media.length ? media : r.artifacts).map((a) => a.id);
  let error =
    r.error ??
    (r.stopReason === 'end_turn' ? null : { code: r.stopReason === 'budget_exceeded' ? 'budget_exceeded' : 'generation_stopped', message: `Generation stopped (${r.stopReason})` });
  if (!error && !fileIds.length && toolErrors.length) error = classifyToolError(toolErrors.at(-1)!);
  return { fileIds, credits: r.credits.total, error };
}

/** Error outputs of ImageGen/VideoGen calls in a turn (tool.completed is keyed by the tool.started id). */
function generatorErrors(events: readonly TurnEvent[]): string[] {
  const generatorIds = new Set(events.flatMap((e) => (e.type === 'tool.started' && GENERATOR_TOOLS.has(e.name) ? [e.id] : [])));
  return events.flatMap((e) => (e.type === 'tool.completed' && e.isError && generatorIds.has(e.id) ? [e.output] : []));
}

function classifyToolError(output: string): { code: string; message: string } {
  if (QUEUE_FULL.test(output)) return { code: 'upstream_queue_full', message: 'Qoder generation queue is full (another generation is still running); try again later' };
  const detail = output.replace(/^\w+_gen error:\s*/i, '').replace(/request_id[:=]\S+/gi, '').slice(0, 300);
  return { code: 'generation_failed', message: `Generator error: ${detail}` };
}

const usesFolax = (job: MediaJob) => job.kind === 'image' && job.request.provider_used === 'folax';

function inputIds(job: MediaJob): string[] {
  const r = job.request;
  if (job.kind === 'image') return (r.input_file_ids as string[] | undefined) ?? [];
  return [r.first_frame_file_id, r.last_frame_file_id, ...((r.reference_file_ids as string[] | undefined) ?? [])].filter((x): x is string => typeof x === 'string');
}

/** Same collision rule as prepareInput (`a.png`, `a-2.png`, …) so the paths we announce match the mounts. */
function uniquePath(path: string, used: Set<string>): string {
  let candidate = path;
  for (let i = 2; used.has(candidate); i++) candidate = path.replace(/(\.[^./]+)?$/, `-${i}$1`);
  used.add(candidate);
  return candidate;
}

/** Prompts are always passed verbatim; enhancement (if requested) already happened in the PromptEnhancer. */
function promptSection(prompt: string): string {
  return `Pass the prompt below to the tool exactly as written (verbatim: do not rewrite, translate, shorten or extend it).\n\nPrompt:\n${prompt}`;
}

function imageInstruction(r: Record<string, unknown>, inputs: JobInput[]): string {
  const images = inputs.map((i) => i.path);
  const lines = [
    'Generate exactly one image with the ImageGen tool, then deliver it with DeliverArtifacts.',
    'Tool parameters:',
    `- size: ${r.size}`,
    ...(images.length ? [`- images: ${JSON.stringify(images)} (input images to edit/compose, already in your sandbox)`] : []),
    `Parameters: size=${r.size}${images.length ? ` images=${images.join(',')}` : ''}`,
    '',
    promptSection(String(r.prompt)),
  ];
  return lines.join('\n');
}

function videoInstruction(r: Record<string, unknown>, inputs: JobInput[]): string {
  const pathOf = (id: unknown) => inputs.find((i) => i.file.id === id)?.path;
  const refIds = (r.reference_file_ids as string[] | undefined) ?? [];
  const media: Record<string, unknown> = {};
  const first = pathOf(r.first_frame_file_id);
  const last = r.last_frame_file_id ? inputs.filter((i) => i.file.id === r.last_frame_file_id).at(-1)?.path : undefined;
  if (first) media.first_frame = { type: 'image', source: first };
  if (last) media.last_frame = { type: 'image', source: last };
  if (refIds.length) media.references = inputs.filter((i) => refIds.includes(i.file.id)).map((i) => ({ type: 'image', source: i.path }));
  const lines = [
    'Generate exactly one video with the VideoGen tool, then deliver the MP4 with DeliverArtifacts.',
    'Tool parameters:',
    `- mode: ${r.mode}`,
    `- duration_seconds: ${r.seconds}`,
    `- resolution: ${r.resolution}`,
    `- ratio: ${r.ratio}`,
    `- audio: ${r.audio}`,
    ...(Object.keys(media).length ? [`- media: ${JSON.stringify(media)}`] : []),
    `Parameters: mode=${r.mode} seconds=${r.seconds} resolution=${r.resolution} ratio=${r.ratio} audio=${r.audio}`,
    '',
    promptSection(String(r.prompt)),
  ];
  return lines.join('\n');
}
