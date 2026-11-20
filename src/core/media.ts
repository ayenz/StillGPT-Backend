import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { type ContentBlock, conversations, files, mediaJobs } from '../db/schema.js';
import type { ImageProvider } from '../config.js';
import { AppError, badRequest, notFound, toAppError } from '../errors.js';
import { newId } from '../ids.js';
import type { Logger } from '../log.js';
import { type FaceBox, type FaceSwapClient, PATCH_MISALIGNED, type PasteAlignment, type SwapperOptions } from '../providers/faceswap.js';
import { FOLAX_PROMPT_MAX, type FolaxClient, type FolaxEditMode, type FolaxVideoJob, folaxError, toFolaxRatio } from '../providers/folax.js';
import { UPSCALE_MAX_PIXELS, UPSCALE_MODES, UPSCALE_SCALES, type UpscaleBackend, type UpscaleClient, type UpscaleMode, type UpscaleScale } from '../providers/upscale.js';
import type { QoderClient } from '../qoder/client.js';
import type { QoderEvent } from '../qoder/types.js';
import { ATTACHMENT_DIR } from './attachments.js';
import type { EventBus } from './bus.js';
import { applyPatch, type FaceSwapEngine, type FaceSwapSettingsPatch, type FaceSwapSettingsService } from './faceSwap.js';
import type { ConversationService } from './conversations.js';
import type { PromptEnhancer } from './enhancer.js';
import { MAX_VARIATIONS, type PromptVariator, VARIATION_AXES, type VariationAxis } from './variations.js';
import type { Artifact, Credits, TurnEvent } from './events.js';
import type { FcmMessage, FcmService } from './fcm.js';
import type { PushMessage, PushService } from './push.js';
import type { MediaStore, StoredFile, UrlScope } from './storage.js';
import type { TurnResult, TurnRunner } from './turns.js';
import type { UsageService } from './usage.js';
import type { WebhookService } from './webhooks.js';

export type MediaJob = typeof mediaJobs.$inferSelect;

export const IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536', '768x1024', '1024x768', '1024x1280', '1280x1024', '1024x1792', '1792x1024', '2560x1080'] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];
/** Most images one `POST /images` may ask for (`n`); each is its own Qoder job, run in parallel. */
export const MAX_IMAGE_BATCH = 10;
/** Most images one face swap may ask for. */
export const MAX_FACE_SWAP_BATCH = 4;

export { FACE_SWAP_PROMPT, FACE_SWAP_CROP_PROMPT, FACE_SWAP_POLISH_PROMPT } from './faceSwap.js';
/** Qoder turns a close-up engine (`qoder_crop`, `swapper_polish`) may use when the sidecar rejects the edit as misaligned. */
export const MAX_FACE_CROP_ATTEMPTS = 3;

/** The allowed image size whose aspect ratio is closest to `width`x`height` (log-ratio distance). */
export function closestImageSize(width: number | undefined, height: number | undefined): ImageSize {
  if (!width || !height || width <= 0 || height <= 0) return '1024x1024';
  const target = Math.log(width / height);
  let best: ImageSize = '1024x1024';
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const size of IMAGE_SIZES) {
    const [w, h] = size.split('x').map(Number) as [number, number];
    const diff = Math.abs(Math.log(w / h) - target);
    if (diff < bestDiff - 1e-9) {
      best = size;
      bestDiff = diff;
    }
  }
  return best;
}

/** Aspect ratios this close (|log ratio| difference) count as the same shape for `largestImageSize`. */
const SIZE_RATIO_TOLERANCE = 0.07;

/**
 * The LARGEST allowed image size with (nearly) the closest aspect ratio to `width`x`height`: among the sizes within
 * SIZE_RATIO_TOLERANCE of the best ratio match, the one with the most pixels (3:4 → 1024x1280, not 768x1024).
 * Used for whole-photo face swaps, where more pixels keep more of the target's detail.
 */
export function largestImageSize(width: number | undefined, height: number | undefined): ImageSize {
  if (!width || !height || width <= 0 || height <= 0) return '1024x1024';
  const target = Math.log(width / height);
  const dims = IMAGE_SIZES.map((size) => {
    const [w, h] = size.split('x').map(Number) as [number, number];
    return { size, diff: Math.abs(Math.log(w / h) - target), area: w * h };
  });
  const best = Math.min(...dims.map((d) => d.diff));
  const near = dims.filter((d) => d.diff <= best + SIZE_RATIO_TOLERANCE + 1e-9);
  near.sort((a, b) => b.area - a.area || a.diff - b.diff);
  return near[0]!.size;
}

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
  /**
   * The user's own words when `prompt` was already enhanced client-side (✨ then Generate). Tells the variator which
   * details the user asked for; default: `prompt` itself.
   */
  userPrompt?: string;
  callbackUrl?: string;
  /** Server-side extras merged into the stored job `request` (e.g. `face_swap`); never set from client input. */
  extra?: Record<string, unknown>;
}

/** Upscale of one of the user's images (free, no quota). */
export interface UpscaleRequest {
  userId: string;
  fileId: string;
  /** Default 4. */
  scale?: UpscaleScale;
  /** Default `natural`. */
  mode?: UpscaleMode;
  callbackUrl?: string;
}

/** `request.upscale` of an upscale job; the optional fields are filled in when it finishes. */
export interface UpscaleJobInfo {
  source_file_id: string;
  scale: UpscaleScale;
  mode: UpscaleMode;
  backend?: UpscaleBackend;
  pipeline?: string;
  device?: string;
  width?: number;
  height?: number;
  faces_enhanced?: number;
  /** faces whose eyes were redrawn (GFPGAN eye fix) */
  eyes_fixed?: number;
}

/** A face swap: target image (`:fileId`) + a saved face. */
export interface FaceSwapRequest {
  userId: string;
  targetFileId: string;
  face: { id: string; name: string; fileId: string };
  /** Default: the admin setting `default_engine`. */
  engine?: FaceSwapEngine;
  /** 1–MAX_FACE_SWAP_BATCH, default 1; always 1 for `swapper` (deterministic). */
  n?: number;
  callbackUrl?: string;
  /** Admin experiments: settings patch (nulls ignored) applied on top of the current settings for this batch only. */
  settingsOverride?: FaceSwapSettingsPatch;
  /** Admin experiments: label stored as `request.face_swap.tag` (see listFaceSwapJobsByTag). */
  tag?: string;
}

/** `request.face_swap` of a face swap job. */
export interface FaceSwapJobInfo {
  source_file_id: string;
  face_id: string;
  face_name: string;
  /** Missing on phase-1 jobs (= `qoder`). */
  engine?: FaceSwapEngine;
  /** Admin experiment label (POST /images/:fileId/face-swap `tag`). */
  tag?: string;
  /** The face's reference image (identity source). */
  face_file_id?: string;
  /** Snapshot of the swapper options at creation (`swapper`, `swapper_polish`, and det_thresh for `qoder_crop`). */
  options?: SwapperOptions;
  /** Close-up engines (`qoder_crop`, `swapper_polish`): crop factor at creation. */
  crop_expand?: number;
  /** `swapper_polish`: the swapper's result (internal upload, not an output); the close-up is cut from it and pasted back onto it. */
  swapped_file_id?: string;
  /** Close-up engines: the close-up Qoder edited (internal upload) and where it sits in the base photo. */
  crop_file_id?: string;
  crop_box?: FaceBox;
  /** Close-up engines: the raw Qoder output that got pasted (the edited crop, not a gallery output). */
  qoder_output_file_id?: string;
  /** Close-up engines: Qoder turns started so far (1 + retries after misaligned edits, at most MAX_FACE_CROP_ATTEMPTS). */
  attempts?: number;
  /** Close-up engines: raw Qoder outputs the sidecar rejected as misaligned (internal, not outputs). */
  misaligned_file_ids?: string[];
  /** Close-up engines: how the sidecar aligned the pasted edit. */
  alignment?: PasteAlignment;
  /** `swapper_polish`: set when every polish attempt was misaligned; the output is then the plain swapper result. */
  polish_failed?: 'misaligned';
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
  /**
   * `qoder` (default) or `folax`: image-to-video from `firstFrameFileId` only, always ~5 s / 720p / no audio / aspect of
   * the image (seconds, resolution, ratio and audio are ignored), vendor "AI generated" watermark, shared weekly quota.
   */
  provider?: VideoProvider;
  callbackUrl?: string;
}

export const VIDEO_PROVIDERS = ['qoder', 'folax'] as const;
export type VideoProvider = (typeof VIDEO_PROVIDERS)[number];

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

/** Outcome of an image batch when its last job finished (for one notification per batch). */
export interface BatchOutcome {
  n: number;
  completed: number;
  /** A completed job of the batch, opened on tap when the finishing job itself failed. */
  openId: string | null;
}

/** "Image", "Video", "Upscale 4x", "Face swap". */
function jobLabel(v: Pick<MediaJobView, 'kind' | 'request'>): string {
  const up = v.request.upscale as { scale?: number } | undefined;
  if (up) return up.scale ? `Upscale ${up.scale}x` : 'Upscale';
  if (v.request.face_swap) return 'Face swap';
  return v.kind === 'video' ? 'Video' : 'Image';
}

const clip = (text: string, max = 140) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The push notification for a finished job (or, with `batch`, for its whole image batch). No prompt text: it shows
 * on lock screens. The picture is the result's preview rendition (never the full-size file).
 */
export function jobPushMessage(v: MediaJobView, batch?: BatchOutcome): PushMessage {
  const label = jobLabel(v);
  const ok = v.status === 'completed';
  const picture = ok ? (v.outputs[0]?.previewUrl ?? v.outputs[0]?.thumbnailUrl ?? undefined) : undefined;
  const tag = `job-${v.batch_id ?? v.id}`;
  if (batch && batch.n > 1) {
    const noun = v.request.face_swap ? 'face swap results' : 'images';
    const failed = batch.n - batch.completed;
    const openId = ok ? v.id : batch.openId;
    if (batch.completed === 0)
      return { title: `${label} failed`, body: clip(v.error?.message ?? 'None of the results could be created.'), url: `/gallery/${v.id}`, tag };
    return {
      title: failed ? `${batch.completed} of ${batch.n} ${noun} ready` : `${batch.n} ${noun} ready`,
      body: failed ? `${failed} failed. Tap to open your gallery.` : 'Tap to open them in your gallery.',
      url: openId ? `/gallery/${openId}` : '/gallery',
      tag,
      ...(picture ? { image: picture } : {}),
    };
  }
  if (!ok) return { title: `${label} failed`, body: clip(v.error?.message ?? 'Something went wrong.'), url: `/gallery/${v.id}`, tag };
  return { title: `${label} ready`, body: 'Tap to open it in your gallery.', url: `/gallery/${v.id}`, tag, ...(picture ? { image: picture } : {}) };
}

/**
 * The FCM message (native Android app) for a finished job or, with `batch`, its whole image batch: the same title, body
 * and picture as the Web Push one, plus `data` that routes the tap to `/jobs/<id>` or `/batches/<id>`.
 */
export function jobFcmMessage(v: MediaJobView, batch?: BatchOutcome): FcmMessage {
  const p = jobPushMessage(v, batch);
  const picture = p.image ? { image: p.image } : {};
  if (batch && batch.n > 1 && v.batch_id)
    return { title: p.title, body: p.body, tag: v.batch_id, ...picture, data: { type: 'batch', batch_id: v.batch_id, path: `/batches/${v.batch_id}` } };
  return { title: p.title, body: p.body, tag: v.id, ...picture, data: { type: 'job', job_id: v.id, path: `/jobs/${v.id}` } };
}

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
  /** The faceswap sidecar; null when FACESWAP_URL is unset (engines `swapper`/`qoder_crop` unavailable). */
  faceswap?: FaceSwapClient | null;
  /** Face swap settings (engine default, prompts, swapper options). Needed for face swaps. */
  faceSwapSettings?: FaceSwapSettingsService;
  /** Image upscaler; null/absent when no upscale backend is configured. */
  upscaler?: UpscaleClient | null;
  /** Web Push to the owner's browsers when a job finishes; absent/disabled = no notifications. */
  push?: PushService | null;
  /** FCM to the owner's Android app installs when a job finishes; absent/disabled = no notifications. */
  fcm?: FcmService | null;
  defaultImageProvider: ImageProvider;
  videoConcurrency: number;
  /** Progress ticks and restart-recovery polling. Default 5 s. */
  pollIntervalMs?: number;
  /** Folax video status polling. Default 15 s. */
  folaxVideoPollMs?: number;
  /** Waits before re-submitting a job that Qoder rejected with a full generation queue. Default 30 s, 1, 2, 3, 5 min. */
  queueRetryDelaysMs?: number[];
  /** Waits before re-submitting a job whose generator hit a draining upstream instance (HTTP 423). Default 5, 15, 30 s. */
  drainingRetryDelaysMs?: number[];
}

const DEFAULT_QUEUE_RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 180_000, 300_000];
const DEFAULT_DRAINING_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];
/** Upstream generator throttling, e.g. `Throttling.QueueQuota … Task queue limit exceeded` (HTTP 429). */
const QUEUE_FULL = /QueueQuota|queue limit|Throttling|status=429|HTTP 429/i;
/** Generator backend rotating out, e.g. `image gen HTTP 423: … "message":"instance is draining","type":"draining"`. Transient (seconds). */
const DRAINING = /instance is draining|"type":"draining"|HTTP 423/i;
const GENERATOR_TOOLS = new Set(['ImageGen', 'VideoGen']);

/** Typical wall-clock durations, used only to estimate progress. */
const EXPECTED_MS = { image: 30_000, video: 210_000, folax: 12_000, folax_edit: 18_000, folax_video: 150_000, faceswap: 15_000, upscale: 60_000 } as const;
/** A Folax video is given up after this long (the adapter's own job timeout is 15 min). */
const FOLAX_VIDEO_MAX_MS = 20 * 60_000;
/** Consecutive failed status polls (adapter unreachable, upstream hiccups) before a Folax video job fails. */
const FOLAX_VIDEO_MAX_POLL_ERRORS = 8;
/** How often a busy adapter (429 too_many_jobs: 4 videos running) is asked again before the job fails. */
const FOLAX_VIDEO_MAX_BUSY_RETRIES = 20;
const MAX_RECOVERY_MS = 45 * 60_000;
/** At most one `provider.degraded` webhook per provider per hour. */
const DEGRADED_THROTTLE_MS = 3600_000;
const PROMPT_MAX = 4000;

// ── gallery cursor ──────────────────────────────────────────────────────────

/** Opaque to clients: base64url of "<created_at in µs since epoch>.<job id>". */
export const encodeJobCursor = (us: string, id: string) => Buffer.from(`${us}.${id}`).toString('base64url');

export function decodeJobCursor(cursor: string): { us: string; id: string } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const m = /^(\d{1,19})\.([A-Za-z0-9_-]{1,64})$/.exec(raw);
  if (!m) throw badRequest('cursor is invalid; start again without it', 'invalid_cursor', { param: 'cursor' });
  return { us: m[1]!, id: m[2]! };
}

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
  userPrompt: z.string().trim().max(PROMPT_MAX).optional(),
  callbackUrl: z.url({ protocol: /^https?$/ }).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

const upscaleSchema = z.object({
  userId: z.string().min(1),
  fileId: z.string().min(1),
  scale: z.union(UPSCALE_SCALES.map((n) => z.literal(n))).default(4),
  mode: z.enum(UPSCALE_MODES).default('natural'),
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
    provider: z.enum(VIDEO_PROVIDERS).optional(),
    callbackUrl: z.url({ protocol: /^https?$/ }).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.provider === 'folax') {
      if (!v.firstFrameFileId) ctx.addIssue({ code: 'custom', path: ['firstFrameFileId'], message: 'provider folax animates an image: first_frame_file_id is required' });
      if (v.lastFrameFileId) ctx.addIssue({ code: 'custom', path: ['lastFrameFileId'], message: 'provider folax does not support a last frame' });
      if (v.referenceFileIds.length) ctx.addIssue({ code: 'custom', path: ['referenceFileIds'], message: 'provider folax does not support reference images' });
    }
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
   * `n` parallel jobs of one prompt sharing a batch id. The prompt is enhanced once for all of them.
   * Every job follows the normal provider routing: a Qoder job makes 1 image, a Folax job 2 (so a Folax batch of n
   * gives 2n images; Folax calls run in parallel up to FOLAX_CONCURRENCY).
   * `wait` resolves once every job finished (synchronous APIs); otherwise right after the jobs started.
   */
  async createImageBatch(req: ImageRequest, n: number, opts: { wait?: boolean } = {}): Promise<ImageBatchView> {
    if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGE_BATCH) throw badRequest(`n must be an integer between 1 and ${MAX_IMAGE_BATCH}`, 'validation_error', { param: 'n' });
    const { v, request } = await this.prepareImage(req);
    // every Folax edit uses one of the shared weekly edits: one per request, no batches
    if (request.folax_edit && n > 1) throw badRequest('Folax edits make one image per request; send n: 1 (or omit n)', 'validation_error', { param: 'n' });
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

  /**
   * Upscale one of the user's images 2x/4x (`natural` or `sharp`) on the upscale sidecar: an async image job with
   * `provider_used: upscale` and `request.upscale`. Free and deliberately without the credit-limit check.
   */
  async upscale(req: UpscaleRequest): Promise<MediaJobView> {
    const v = validate(upscaleSchema, req);
    if (!this.d.upscaler) throw new AppError(503, 'upscale_unavailable', 'Upscaling is not configured');
    const [input] = await this.loadInputs(v.userId, [v.fileId]);
    // unreadable here: let the sidecar judge it (BAD_IMAGE fails the job)
    const { width, height } = await imageSizeOf(this.d.store.pathOf(input!.file));
    if (width && height && width * height > UPSCALE_MAX_PIXELS)
      throw badRequest(`The image has ${width}x${height} pixels; upscaling takes at most ${UPSCALE_MAX_PIXELS / 1e6} MP`, 'image_too_large', {
        width,
        height,
        max_pixels: UPSCALE_MAX_PIXELS,
      });
    const info: UpscaleJobInfo = { source_file_id: v.fileId, scale: v.scale, mode: v.mode };
    const request = {
      prompt: `Upscale ${v.scale}x (${v.mode === 'sharp' ? 'Sharp' : 'Natural'})`,
      enhance: false,
      input_file_ids: [v.fileId],
      provider: 'upscale',
      provider_used: 'upscale',
      upscale: info,
    };
    const job = await this.insertJob(v.userId, 'image', request, v.callbackUrl);
    void this.run(job);
    return this.view(job);
  }

  /** Folax is configured and not known to be down (cached state; no probe). */
  private assertFolaxUsable() {
    if (!this.d.folax) throw badRequest('The folax provider is not configured', 'provider_unavailable', { param: 'provider' });
    if (this.d.folax.knownDown()) throw new AppError(503, 'provider_unavailable', 'Folax is unavailable right now', { provider: 'folax' });
  }

  /**
   * Face swap on `targetFileId` with a saved face, as an async image batch (one job per result). Engines:
   * - `swapper`: one job (n forced to 1, the sidecar is deterministic) run by the faceswap sidecar; free.
   * - `qoder`: n Qoder edits of the whole photo (image 1 = target, image 2 = face) with the admin's `qoder_prompt`,
   *   at the largest allowed size of the target's aspect ratio.
   * - `qoder_crop`: n jobs; each crops the target's face (sidecar), lets Qoder edit the 1024x1024 close-up with
   *   `qoder_crop_prompt`, then pastes it back into the original photo (sidecar).
   * - `swapper_polish`: n jobs; each runs the swapper (sidecar), then the `qoder_crop` flow on the swapped photo with
   *   `polish_prompt`. Every job does its own (cheap, deterministic) swapper step, so each job is self-contained.
   * Close-up engines retry the Qoder edit (new turn) when the sidecar rejects it as misaligned.
   * The engine defaults to the admin setting (falling back to `qoder` when that default is unavailable); an explicitly
   * requested engine that is not available is a 400 `engine_unavailable`.
   * The jobs' `request.face_swap` records source, face and engine for the gallery.
   */
  async createFaceSwapBatch(req: FaceSwapRequest): Promise<ImageBatchView> {
    const settingsService = this.d.faceSwapSettings;
    if (!settingsService) throw new AppError(503, 'engine_unavailable', 'Face swap is not configured');
    // snapshot: every job of the batch runs with these values (the runner never reads the live settings)
    const settings = applyPatch(settingsService.get(), req.settingsOverride);
    const requested = req.n ?? 1;
    if (!Number.isInteger(requested) || requested < 1 || requested > MAX_FACE_SWAP_BATCH)
      throw badRequest(`n must be an integer between 1 and ${MAX_FACE_SWAP_BATCH}`, 'validation_error', { param: 'n' });
    const [target] = await this.loadInputs(req.userId, [req.targetFileId]);
    // no engine asked for: a default engine whose sidecar is down falls back to whole-image Qoder instead of failing
    const engine =
      req.engine ?? ((await settingsService.available(settings.default_engine, { recheck: true })) ? settings.default_engine : 'qoder');
    if (!(await settingsService.available(engine, { recheck: true })))
      throw badRequest(`The face swap engine ${engine} is not available right now`, 'engine_unavailable', { param: 'engine' });
    const n = engine === 'swapper' ? 1 : requested;
    const info: FaceSwapJobInfo = {
      source_file_id: req.targetFileId,
      face_id: req.face.id,
      face_name: req.face.name,
      engine,
      face_file_id: req.face.fileId,
      ...(engine !== 'qoder' ? { options: settings.swapper } : {}),
      ...(isCloseUpEngine(engine) ? { crop_expand: settings.crop_expand } : {}),
      ...(req.tag ? { tag: req.tag } : {}),
    };
    const base = {
      userId: req.userId,
      enhance: false,
      inputFileIds: [req.targetFileId, req.face.fileId],
      callbackUrl: req.callbackUrl,
    };
    if (engine === 'swapper')
      return this.createImageBatch(
        { ...base, prompt: `Face swap: ${req.face.name}`, size: '1024x1024', provider: 'qoder', extra: { face_swap: info, provider: 'faceswap', provider_used: 'faceswap' } },
        1,
      );
    if (isCloseUpEngine(engine)) {
      const prompt = engine === 'swapper_polish' ? settings.polish_prompt : settings.qoder_crop_prompt;
      return this.createImageBatch({ ...base, prompt, size: '1024x1024', provider: 'qoder', extra: { face_swap: info } }, n);
    }
    const { width, height } = await imageSizeOf(this.d.store.pathOf(target!.file));
    return this.createImageBatch({ ...base, prompt: settings.qoder_prompt, size: largestImageSize(width, height), provider: 'qoder', extra: { face_swap: info } }, n);
  }

  /**
   * Admin test of the swapper engine: runs the sidecar synchronously on one of the user's images and a saved face's
   * image, without a job or gallery item. Returns the result as a data URL.
   */
  async testFaceSwap(req: { userId: string; targetFileId: string; faceFileId: string; options: SwapperOptions }) {
    if (!this.d.faceswap) throw new AppError(503, 'faceswap_unavailable', 'The face swap service is not configured (FACESWAP_URL)');
    const [target, face] = await this.loadInputs(req.userId, [req.targetFileId, req.faceFileId]);
    const started = Date.now();
    const r = await this.d.faceswap.swap(await this.d.store.read(target!.file), [await this.d.store.read(face!.file)], req.options);
    return {
      image_data_url: `data:${r.mimeType};base64,${r.bytes.toString('base64')}`,
      timings_ms: { ...r.timingsMs, total: Date.now() - started },
      width: r.width,
      height: r.height,
      target_faces: r.targetFaces,
      source_faces: r.sourceFaces,
      backend: r.backend,
    };
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
    const folax = v.provider === 'folax';
    if (folax) this.assertFolaxUsable();
    await this.d.usage.assertWithinLimit(v.userId);
    const frames = [v.firstFrameFileId, v.lastFrameFileId, ...v.referenceFileIds].filter((x): x is string => !!x);
    await this.loadInputs(v.userId, frames);
    const mode = v.firstFrameFileId ? 'first_frame_to_video' : v.referenceFileIds.length ? 'reference_to_video' : 'text_to_video';
    const e = v.enhance
      ? await this.d.enhancer.enhance({
          userId: v.userId,
          prompt: v.prompt,
          kind: 'video',
          firstFrameFileId: v.firstFrameFileId,
          lastFrameFileId: v.lastFrameFileId,
          referenceFileIds: v.referenceFileIds,
          seconds: v.seconds,
          audio: v.audio,
        })
      : null;
    const request = {
      prompt: e?.prompt ?? v.prompt,
      ...(e ? { original_prompt: v.prompt, enhanced: e.enhanced } : {}),
      enhance: v.enhance,
      mode,
      // Folax output is fixed: ~5 s, 720p, no audio, the input image's aspect
      seconds: folax ? 5 : (v.seconds ?? e?.seconds ?? 5),
      resolution: folax ? '720P' : v.resolution,
      // with frames/references the input image decides the shape, so the enhancer's ratio only applies to text_to_video
      ratio: folax ? 'adaptive' : (v.ratio ?? (mode === 'text_to_video' ? (e?.ratio ?? '16:9') : 'adaptive')),
      audio: folax ? false : v.audio,
      first_frame_file_id: v.firstFrameFileId ?? null,
      last_frame_file_id: v.lastFrameFileId ?? null,
      reference_file_ids: v.referenceFileIds,
      provider: v.provider ?? 'qoder',
      provider_used: v.provider ?? 'qoder',
    };
    const job = await this.insertJob(v.userId, 'video', request, v.callbackUrl);
    this.schedule(job);
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

  /** Admin experiments: the user's face swap jobs with `request.face_swap.tag = tag`, newest first, all statuses (max 500). */
  async listFaceSwapJobsByTag(userId: string, tag: string): Promise<MediaJobView[]> {
    const rows = await this.d.db
      .select()
      .from(mediaJobs)
      .where(and(eq(mediaJobs.userId, userId), isNull(mediaJobs.deletedAt), sql`${mediaJobs.request} -> 'face_swap' ->> 'tag' = ${tag}`))
      .orderBy(desc(mediaJobs.createdAt), desc(mediaJobs.id))
      .limit(500);
    return Promise.all(rows.map((r) => this.view(r)));
  }

  /**
   * One page of the gallery, newest first, for infinite scroll. Keyset-paged on (created_at, id): jobs of a batch share
   * created_at, and new jobs arriving while the user scrolls never shift or repeat items. The cursor carries created_at in
   * microseconds (Postgres precision; a JS Date would round it to milliseconds and skip or repeat rows).
   */
  async listJobsPage(
    userId: string,
    opts: { kind?: 'image' | 'video'; batchId?: string; statuses?: MediaJob['status'][]; limit?: number; cursor?: string } = {},
  ): Promise<{ items: MediaJobView[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const conds = [eq(mediaJobs.userId, userId), isNull(mediaJobs.deletedAt)];
    if (opts.kind) conds.push(eq(mediaJobs.kind, opts.kind));
    if (opts.batchId) conds.push(eq(mediaJobs.batchId, opts.batchId));
    if (opts.statuses?.length) conds.push(inArray(mediaJobs.status, opts.statuses));
    if (opts.cursor) {
      const c = decodeJobCursor(opts.cursor);
      conds.push(sql`(${mediaJobs.createdAt}, ${mediaJobs.id}) < (to_timestamp(0) + ${c.us}::bigint * interval '1 microsecond', ${c.id})`);
    }
    const rows = await this.d.db
      .select({ job: mediaJobs, us: sql<string>`(extract(epoch from ${mediaJobs.createdAt}) * 1000000)::bigint::text` })
      .from(mediaJobs)
      .where(and(...conds))
      .orderBy(desc(mediaJobs.createdAt), desc(mediaJobs.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: await Promise.all(page.map((r) => this.view(r.job))),
      nextCursor: rows.length > limit && last ? encodeJobCursor(last.us, last.job.id) : null,
    };
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
   * Per-image request overrides for `variations`. The first image always keeps the (enhanced) prompt as written
   * (`variation: {original: true}`), so at least one result matches what the user asked for; images 1..n-1 get a varied
   * `prompt` plus `base_prompt` and `variation: {changed, vary, keep, repeated}`. n = 1 is just the original.
   * Variations are a nice-to-have, so a failure falls back to the original prompt for every image instead of failing.
   */
  private async variantsFor(v: ValidImage, request: Record<string, unknown>, n: number): Promise<Record<string, unknown>[]> {
    if (!v.variations) return Array.from({ length: n }, () => ({}));
    if (!this.d.variator) throw badRequest('Prompt variations are not available', 'validation_error', { param: 'variations' });
    const axes = typeof v.variations === 'object' ? v.variations : {};
    const base = String(request.prompt);
    const original = { base_prompt: base, variation: { original: true } };
    if (n === 1) return [original];
    try {
      // input images are what is being edited: variations stay edits of them instead of moving away from them.
      // `userPrompt` (the user's own words, before enhancing) tells the variator which details were asked for explicitly.
      const r = await this.d.variator.vary({
        userId: v.userId,
        prompt: base,
        // the typed text before a client-side enhance, else what was sent (which is then the user's own text,
        // or the input of a server-side `enhance: true`)
        userPrompt: v.userPrompt || v.prompt,
        editFileIds: v.inputFileIds,
        vary: axes.vary,
        keep: axes.keep,
        n: Math.min(n - 1, MAX_VARIATIONS),
      });
      // fewer usable variations than images: the remaining images reuse them round-robin
      const varied = Array.from({ length: n - 1 }, (_, i) => {
        const x = r.variations[i % r.variations.length]!;
        return { prompt: x.prompt, base_prompt: base, variation: { changed: x.changed, vary: r.vary, keep: r.keep, repeated: i >= r.variations.length } };
      });
      return [original, ...varied];
    } catch (err) {
      if (err instanceof AppError && err.status < 500) throw err;
      this.d.log.warn('media.variations_failed', { err });
      // visible on the job, so the UI can tell why the images look alike
      return [{ ...original, variations_failed: true }, ...Array.from({ length: n - 1 }, () => ({ base_prompt: base, variations_failed: true }))];
    }
  }

  /** Validate, check limits and inputs, pick the provider and run the enhancer: the stored `request` of an image job. */
  private async prepareImage(req: ImageRequest): Promise<{ v: ValidImage; request: Record<string, unknown> }> {
    const v: ValidImage = validate(imageSchema, req);
    await this.d.usage.assertWithinLimit(v.userId);
    await this.loadInputs(v.userId, v.inputFileIds);
    const provider = v.provider ?? this.d.defaultImageProvider;
    const providerUsed = this.imageProviderFor(v.provider, provider, v.inputFileIds.length);
    const folaxEdit = providerUsed === 'folax' && v.inputFileIds.length > 0;
    if (folaxEdit) this.assertFolaxUsable();
    const e = v.enhance ? await this.d.enhancer.enhance({ userId: v.userId, prompt: v.prompt, kind: 'image', inputFileIds: v.inputFileIds }) : null;
    const prompt = e?.prompt ?? v.prompt;
    // Folax cuts prompts at FOLAX_PROMPT_MAX; under `auto` a longer (e.g. enhanced) prompt goes to Qoder instead of losing its end
    const tooLongForFolax = providerUsed === 'folax' && provider !== 'folax' && prompt.length > FOLAX_PROMPT_MAX;
    const request = {
      prompt,
      ...(e ? { original_prompt: v.prompt, enhanced: e.enhanced } : {}),
      ...(v.userPrompt ? { user_prompt: v.userPrompt } : {}),
      size: v.size ?? e?.size ?? '1024x1024',
      enhance: v.enhance,
      input_file_ids: v.inputFileIds,
      provider,
      provider_used: tooLongForFolax ? 'qoder' : providerUsed,
      ...(tooLongForFolax ? { fallback_reason: 'prompt_too_long_for_folax' } : {}),
      ...(folaxEdit ? { folax_edit: { mode: 'instruction' } } : {}),
      ...v.extra,
    };
    return { v, request };
  }

  /**
   * Folax does text-to-image under `auto`/`folax`; it edits (one input image → one result, weekly quota) only when asked
   * for explicitly. Edits under `auto` go to Qoder ImageGen.
   */
  private imageProviderFor(explicit: ImageProvider | undefined, provider: ImageProvider, inputs: number): 'qoder' | 'folax' {
    if (explicit === 'folax' && !this.d.folax) throw badRequest('The folax image provider is not configured', 'provider_unavailable', { param: 'provider' });
    if (explicit === 'folax' && inputs > 1)
      throw badRequest('provider folax edits exactly one input image; use qoder (or auto) to combine images', 'validation_error', { param: 'input_file_ids' });
    if (explicit === 'folax') return 'folax';
    return provider !== 'qoder' && !inputs && this.d.folax ? 'folax' : 'qoder';
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
      if (upscaleOf(job)) return await this.finish(job.id, await this.runUpscale(job));
      let current = job;
      const engine = faceSwapEngineOf(job);
      if (engine === 'swapper') return await this.finish(job.id, await this.runSwapper(job));
      if (isCloseUpEngine(engine)) current = await this.prepareFaceCrop(job);
      if (usesFolaxVideo(job)) {
        const outcome = await this.runFolaxVideo(job);
        // null: the server is stopping; the job stays in_progress and resumes after the restart
        if (outcome) await this.finish(job.id, outcome);
        return;
      }
      // Folax edits never fall back: Folax is optional and the user picked it
      if (folaxEditOf(job)) return await this.finish(job.id, await this.runFolaxEdit(job));
      if (usesFolax(job)) {
        try {
          return await this.finish(job.id, await this.runFolax(job));
        } catch (err) {
          current = await this.fallBackFromFolax(job, toAppError(err));
        }
      }
      const outcome = await this.runQoderWithRetry(current);
      await this.finish(job.id, isCloseUpEngine(engine) ? await this.completeFaceCrop(current, outcome) : outcome);
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
   * Qoder turn with automatic re-submission on transient generator errors:
   * - the upstream generation queue is full (the account only gets a few concurrent generations; a long-running job elsewhere blocks new ones);
   * - the generator instance is draining (HTTP 423 while Qoder rotates instances; clears within seconds).
   * Each kind has its own retry schedule.
   */
  private async runQoderWithRetry(job: MediaJob): Promise<Outcome> {
    const schedules: Record<string, number[]> = {
      upstream_queue_full: this.d.queueRetryDelaysMs ?? DEFAULT_QUEUE_RETRY_DELAYS_MS,
      upstream_draining: this.d.drainingRetryDelaysMs ?? DEFAULT_DRAINING_RETRY_DELAYS_MS,
    };
    const attempts: Record<string, number> = {};
    for (;;) {
      const outcome = await this.runQoder(job);
      const code = outcome.error?.code;
      const delays = code ? schedules[code] : undefined;
      const attempt = code ? (attempts[code] ?? 0) : 0;
      if (!code || !delays || attempt >= delays.length || this.stopped) return outcome;
      attempts[code] = attempt + 1;
      this.d.log.warn(code === 'upstream_draining' ? 'media.draining_retry' : 'media.queue_full_retry', { jobId: job.id, attempt: attempt + 1, waitMs: delays[attempt] });
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

  /**
   * Folax prompt edit (`instruction` with the job's prompt) of the job's one input image. The job id is the
   * Idempotency-Key, so a re-run after a restart gets the adapter's stored result without using quota again. Free.
   */
  private async runFolaxEdit(job: MediaJob): Promise<Outcome> {
    if (!this.d.folax) throw new AppError(503, 'provider_unavailable', 'The folax provider is not configured');
    const mode = folaxEditOf(job)!;
    const [input] = await this.loadInputs(job.userId, inputIds(job));
    const r = await this.d.folax.edit({ mode, image: await this.d.store.read(input!.file), prompt: String(job.request.prompt), idempotencyKey: job.id });
    const file = await this.d.store.save({ userId: job.userId, kind: 'artifact', filename: r.filename, mimeType: r.mimeType, bytes: r.bytes, jobId: job.id });
    await this.d.usage.record({ userId: job.userId, kind: 'image', model: `folax-${mode}`, jobId: job.id, credits: { model: 0, sandbox: 0, total: 0 }, free: true });
    return { fileIds: [file.id], credits: 0, error: null };
  }

  /**
   * Folax image-to-video: submit (Idempotency-Key = job id), remember the adapter job and upstream task in
   * `request.folax`, poll every `folaxVideoPollMs`, then download the mp4 into our storage. A re-run (restart) polls the
   * remembered job; if the adapter forgot it (404) the upstream task is resumed without quota. Free, never falls back.
   */
  private async runFolaxVideo(job: MediaJob): Promise<Outcome | null> {
    const folax = this.d.folax;
    if (!folax) throw new AppError(503, 'provider_unavailable', 'The folax provider is not configured');
    const pollMs = this.d.folaxVideoPollMs ?? 15_000;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const deadline = Date.now() + FOLAX_VIDEO_MAX_MS;
    let state = (job.request.folax as FolaxVideoState | undefined) ?? null;
    const remember = async (r: FolaxVideoJob) => {
      state = { id: r.id, task_id: r.upstream?.task_id ?? state?.task_id ?? null, client_task_id: r.upstream?.client_task_id ?? state?.client_task_id ?? null };
      job = { ...job, request: { ...job.request, folax: state } };
      await this.d.db.update(mediaJobs).set({ request: job.request }).where(eq(mediaJobs.id, job.id));
    };

    if (!state?.id) {
      const [frame] = await this.loadInputs(job.userId, [String(job.request.first_frame_file_id)]);
      const image = await this.d.store.read(frame!.file);
      for (let attempt = 0; ; attempt++) {
        try {
          await remember(await folax.submitVideo({ image, prompt: String(job.request.prompt), idempotencyKey: job.id }));
          break;
        } catch (err) {
          const e = toAppError(err);
          // 429 too_many_jobs (4 videos running) or our side timed out / lost the adapter: the same key makes a retry safe
          const busy = e.code === 'provider_busy';
          const transient = (e.code === 'folax_timeout' && e.details?.folax_code === undefined) || e.details?.folax_code === 'unreachable';
          if (this.stopped) return null;
          if (!(busy || transient) || attempt >= (busy ? FOLAX_VIDEO_MAX_BUSY_RETRIES : 3) || Date.now() > deadline) throw e;
          this.d.log.warn('media.folax_video_retry', { jobId: job.id, code: e.code, attempt: attempt + 1 });
          await sleep(busy ? Math.max(pollMs, Math.min(Number(e.details?.retry_after ?? 30) * 1000, 2 * pollMs)) : pollMs);
        }
      }
    }

    let errors = 0;
    for (;;) {
      if (this.stopped) return null;
      let st: FolaxVideoJob;
      try {
        st = await folax.videoStatus(state!.id);
        errors = 0;
      } catch (err) {
        const e = toAppError(err);
        if (e.code === 'folax_not_found') {
          // the adapter forgot the job (restart): continue the same upstream task, or replay the submit by key
          this.d.log.warn('media.folax_video_resume', { jobId: job.id, taskId: state!.task_id });
          if (state!.task_id) await remember(await folax.resumeVideo(state!.task_id, state!.client_task_id));
          else {
            const [frame] = await this.loadInputs(job.userId, [String(job.request.first_frame_file_id)]);
            await remember(await folax.submitVideo({ image: await this.d.store.read(frame!.file), prompt: String(job.request.prompt), idempotencyKey: job.id }));
          }
          continue;
        }
        // 4xx and a rejected token end the job; an unreachable adapter or upstream hiccups get a few more polls
        const down = e.code === 'provider_unavailable' && e.details?.folax_code !== 'unreachable';
        if (e.status < 500 || down || ++errors >= FOLAX_VIDEO_MAX_POLL_ERRORS) throw e;
        this.d.log.warn('media.folax_video_poll_failed', { jobId: job.id, code: e.code, errors });
        await sleep(pollMs);
        continue;
      }
      if (st.status === 'succeeded') break;
      if (st.status === 'failed') {
        folax.invalidateUsage();
        const e = folaxError(502, { error: { code: st.error?.code ?? 'upstream_task_failed', message: st.error?.message ?? 'Folax video generation failed' } });
        return { fileIds: [], credits: 0, error: { code: e.code, message: e.message } };
      }
      if (Date.now() > deadline) return { fileIds: [], credits: 0, error: { code: 'timeout', message: 'The Folax video did not finish in time' } };
      await sleep(pollMs);
    }

    const bytes = await folax.videoContent(state!.id);
    folax.invalidateUsage();
    const file = await this.d.store.save({ userId: job.userId, kind: 'artifact', filename: `folax-${job.id}.mp4`, mimeType: 'video/mp4', bytes, jobId: job.id });
    await this.d.usage.record({ userId: job.userId, kind: 'video', model: 'folax-video', jobId: job.id, credits: { model: 0, sandbox: 0, total: 0 }, free: true });
    return { fileIds: [file.id], credits: 0, error: null };
  }

  /** Upscale on the sidecar (GPU, else CPU); the JPEG is the only output, `request.upscale` gets what ran. Free. */
  private async runUpscale(job: MediaJob): Promise<Outcome> {
    if (!this.d.upscaler) throw new AppError(503, 'upscale_unavailable', 'Upscaling is not configured');
    const info = upscaleOf(job)!;
    const [source] = await this.loadInputs(job.userId, [info.source_file_id]);
    const r = await this.d.upscaler.upscale(await this.d.store.read(source!.file), { scale: info.scale, mode: info.mode });
    const file = await this.d.store.save({
      userId: job.userId,
      kind: 'artifact',
      filename: `upscale-${info.scale}x-${baseName(source!.file.filename)}.${extOf(r.mimeType)}`,
      mimeType: r.mimeType,
      bytes: r.bytes,
      jobId: job.id,
    });
    const done: UpscaleJobInfo = {
      ...info,
      backend: r.backend,
      pipeline: r.pipeline,
      device: r.device,
      width: r.width,
      height: r.height,
      faces_enhanced: r.facesEnhanced,
      eyes_fixed: r.eyesFixed,
    };
    await this.d.db.update(mediaJobs).set({ request: { ...job.request, upscale: done } }).where(eq(mediaJobs.id, job.id));
    await this.d.usage.record({ userId: job.userId, kind: 'image', model: 'upscale', jobId: job.id, credits: { model: 0, sandbox: 0, total: 0 }, free: true });
    return { fileIds: [file.id], credits: 0, error: null };
  }

  // ── face swap engines ───────────────────────────────────────────────────

  /** `swapper`: the sidecar swaps the face into the target at its original resolution. One output, free. */
  private async runSwapper(job: MediaJob): Promise<Outcome> {
    const { r, target } = await this.swapFace(job);
    const file = await this.d.store.save({
      userId: job.userId,
      kind: 'artifact',
      filename: `faceswap-${baseName(target.filename)}.${extOf(r.mimeType)}`,
      mimeType: r.mimeType,
      bytes: r.bytes,
      jobId: job.id,
    });
    return { fileIds: [file.id], credits: 0, error: null };
  }

  /** Sidecar swap of the job's face into its target photo, recorded as free usage (`model: "faceswap"`). */
  private async swapFace(job: MediaJob) {
    if (!this.d.faceswap) throw new AppError(503, 'faceswap_unavailable', 'The face swap service is not configured');
    const fs = job.request.face_swap as FaceSwapJobInfo;
    const [target, face] = await this.loadInputs(job.userId, [fs.source_file_id, faceFileIdOf(job)]);
    const r = await this.d.faceswap.swap(await this.d.store.read(target!.file), [await this.d.store.read(face!.file)], fs.options);
    this.d.log.info('faceswap.swapped', { jobId: job.id, backend: r.backend, timings_ms: r.timingsMs });
    await this.d.usage.record({ userId: job.userId, kind: 'image', model: 'faceswap', jobId: job.id, credits: { model: 0, sandbox: 0, total: 0 }, free: true });
    return { r, target: target!.file };
  }

  /** Store a new `request.face_swap` on the job; returns the updated row. */
  private async saveFaceSwap(job: MediaJob, fs: FaceSwapJobInfo, set: Partial<Pick<MediaJob, 'credits' | 'qoderSessionId' | 'lastEventId'>> = {}, extra: Record<string, unknown> = {}): Promise<MediaJob> {
    const request = { ...job.request, ...extra, face_swap: fs };
    const [row] = await this.d.db
      .update(mediaJobs)
      .set({ request, ...set })
      .where(eq(mediaJobs.id, job.id))
      .returning();
    return row ?? { ...job, ...set, request };
  }

  /**
   * Close-up engines, step 1 (each sub-step is stored on the job, so a re-run after a restart skips what is done):
   * - `swapper_polish` only: the swapper result is saved as an internal upload (`face_swap.swapped_file_id`);
   * - the sidecar cuts a square around the face of the base photo (the swapped photo for `swapper_polish`, else the
   *   target); the crop becomes the job's first input image in place of the target;
   * - `face_swap.attempts` is at least 1 (the Qoder turn about to start; a job re-queued because its turn never reached
   *   Qoder reuses that attempt).
   */
  private async prepareFaceCrop(job: MediaJob): Promise<MediaJob> {
    let current = job;
    let fs = job.request.face_swap as FaceSwapJobInfo;
    if (fs.engine === 'swapper_polish' && !fs.swapped_file_id) {
      const { r } = await this.swapFace(current);
      const swapped = await this.d.store.save({
        userId: job.userId,
        kind: 'upload',
        filename: `face-swapped.${extOf(r.mimeType)}`,
        mimeType: r.mimeType,
        bytes: r.bytes,
        jobId: job.id,
      });
      fs = { ...fs, swapped_file_id: swapped.id };
      current = await this.saveFaceSwap(current, fs);
    }
    if (!fs.crop_file_id || !fs.crop_box) {
      if (!this.d.faceswap) throw new AppError(503, 'faceswap_unavailable', 'The face swap service is not configured');
      const [base] = await this.loadInputs(job.userId, [fs.swapped_file_id ?? fs.source_file_id]);
      const r = await this.d.faceswap.crop(await this.d.store.read(base!.file), { expand: fs.crop_expand, detThresh: fs.options?.det_thresh, size: 1024 });
      const crop = await this.d.store.save({ userId: job.userId, kind: 'upload', filename: 'face-crop.png', mimeType: 'image/png', bytes: r.crop, jobId: job.id });
      fs = { ...fs, crop_file_id: crop.id, crop_box: r.box };
      current = await this.saveFaceSwap(current, { ...fs, attempts: Math.max(fs.attempts ?? 0, 1) }, {}, { input_file_ids: [crop.id, faceFileIdOf(job)] });
    } else if (!fs.attempts) {
      current = await this.saveFaceSwap(current, { ...fs, attempts: 1 });
    }
    return current;
  }

  /**
   * Close-up engines, step 3: paste Qoder's edit back, and when the sidecar rejects it as misaligned (Qoder changed
   * the framing), run a new Qoder turn, up to MAX_FACE_CROP_ATTEMPTS turns in all. Credits of all turns add up on the
   * job: before each retry, the credits so far are stored in the job's `credits` (with `face_swap.attempts` + 1, the
   * rejected output in `face_swap.misaligned_file_ids` and the old session cleared), so a restart resumes the new turn
   * and never pays again for an attempt already made.
   * Still misaligned after the last attempt: `swapper_polish` completes with the plain swapper result
   * (`face_swap.polish_failed: "misaligned"`), `qoder_crop` fails with `qoder_misaligned`.
   */
  private async completeFaceCrop(job: MediaJob, first: Outcome): Promise<Outcome> {
    let current = job;
    let outcome = first;
    for (;;) {
      // credits of earlier (misaligned) attempts of this job
      const banked = current.credits ?? 0;
      const total = (c: number | null) => (c === null && !banked ? null : banked + (c ?? 0));
      const fs = current.request.face_swap as FaceSwapJobInfo;
      const r = await this.pasteFaceCrop(current, outcome);
      if (!('misaligned' in r)) {
        if (r.fs) await this.saveFaceSwap(current, r.fs);
        return { ...r.outcome, credits: total(r.outcome.credits) };
      }
      const attempts = fs.attempts ?? 1;
      const next: FaceSwapJobInfo = { ...fs, attempts, misaligned_file_ids: [...(fs.misaligned_file_ids ?? []), r.misaligned] };
      if (attempts >= MAX_FACE_CROP_ATTEMPTS) return this.giveUpFaceCrop(current, next, total(outcome.credits));
      this.d.log.warn('media.face_crop_misaligned_retry', { jobId: job.id, attempt: attempts + 1 });
      current = await this.saveFaceSwap(current, { ...next, attempts: attempts + 1 }, { credits: total(outcome.credits), qoderSessionId: null, lastEventId: null });
      try {
        outcome = await this.runQoderWithRetry(current);
      } catch (err) {
        const e = toAppError(err);
        return { fileIds: [], credits: total(null), error: { code: e.code, message: e.message } };
      }
    }
  }

  /** Every Qoder edit was misaligned: `swapper_polish` falls back to the swapper result, `qoder_crop` fails. */
  private async giveUpFaceCrop(job: MediaJob, fs: FaceSwapJobInfo, credits: number | null): Promise<Outcome> {
    this.d.log.warn('media.face_crop_misaligned', { jobId: job.id, engine: fs.engine, attempts: fs.attempts });
    if (fs.engine === 'swapper_polish' && fs.swapped_file_id) {
      try {
        const [swapped, target] = await Promise.all([this.d.store.get(fs.swapped_file_id, job.userId), this.d.store.get(fs.source_file_id, job.userId)]);
        // a copy, so the output and the internal intermediate stay separate files (trash, gallery)
        const file = await this.d.store.save({
          userId: job.userId,
          kind: 'artifact',
          filename: `faceswap-${baseName(target.filename)}.${extOf(swapped.mimeType)}`,
          mimeType: swapped.mimeType,
          bytes: await this.d.store.read(swapped),
          jobId: job.id,
        });
        await this.saveFaceSwap(job, { ...fs, polish_failed: 'misaligned' });
        return { fileIds: [file.id], credits, error: null };
      } catch (err) {
        const e = toAppError(err);
        await this.saveFaceSwap(job, fs).catch(() => {});
        return { fileIds: [], credits, error: { code: e.code, message: e.message } };
      }
    }
    await this.saveFaceSwap(job, fs);
    return {
      fileIds: [],
      credits,
      error: { code: 'qoder_misaligned', message: `Qoder's edited close-up did not line up with the photo (${fs.attempts ?? MAX_FACE_CROP_ATTEMPTS} attempts)` },
    };
  }

  /**
   * Blend Qoder's edited crop back into the base photo (the ORIGINAL target, or the swapped photo for `swapper_polish`).
   * The pasted photo is the job's only output; the raw crop output stays out of the gallery (its id goes to
   * `face_swap.qoder_output_file_id` in the returned `fs`, stored by the caller). A sidecar `patch_misaligned` returns
   * the rejected raw output's id instead.
   */
  private async pasteFaceCrop(job: MediaJob, outcome: Outcome): Promise<{ outcome: Outcome; fs?: FaceSwapJobInfo } | { misaligned: string }> {
    if (outcome.error || !outcome.fileIds.length) return { outcome };
    let rawId: string | undefined;
    try {
      if (!this.d.faceswap) throw new AppError(503, 'faceswap_unavailable', 'The face swap service is not configured');
      const fs = job.request.face_swap as FaceSwapJobInfo;
      if (!fs.crop_box) throw new AppError(500, 'faceswap_failed', 'The face crop box is missing');
      // outputs of the Qoder turn carry a qoder file id; a paste saved before a restart does not, and edits of earlier
      // misaligned attempts (a resumed job lists all of the job's files) are skipped
      const rejected = new Set(fs.misaligned_file_ids ?? []);
      const outputs = await this.d.db.select().from(files).where(inArray(files.id, outcome.fileIds));
      const raw = outcome.fileIds
        .map((id) => outputs.find((f) => f.id === id))
        .find((f) => f && f.qoderFileId && f.mimeType.startsWith('image/') && !rejected.has(f.id));
      if (!raw) return { outcome: { ...outcome, fileIds: [], error: { code: 'no_output', message: 'Qoder did not deliver an edited crop' } } };
      rawId = raw.id;
      const [target] = await this.loadInputs(job.userId, [fs.source_file_id]);
      const [base] = fs.swapped_file_id ? await this.loadInputs(job.userId, [fs.swapped_file_id]) : [target];
      const r = await this.d.faceswap.paste(await this.d.store.read(base!.file), await this.d.store.read(raw), fs.crop_box);
      const file = await this.d.store.save({
        userId: job.userId,
        kind: 'artifact',
        filename: `faceswap-${baseName(target!.file.filename)}.${extOf(r.mimeType)}`,
        mimeType: r.mimeType,
        bytes: r.bytes,
        jobId: job.id,
      });
      return {
        outcome: { ...outcome, fileIds: [file.id] },
        fs: { ...fs, qoder_output_file_id: raw.id, ...(r.alignment ? { alignment: r.alignment } : {}) },
      };
    } catch (err) {
      const e = toAppError(err);
      if (e.code === PATCH_MISALIGNED && rawId) return { misaligned: rawId };
      this.d.log.error('media.face_paste_failed', { jobId: job.id, code: e.code, err: e.message });
      return { outcome: { fileIds: [], credits: outcome.credits, error: { code: e.code, message: e.message } } };
    }
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

  reportDegraded(provider: string, err: AppError) {
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
    const edit = folaxEditOf(job);
    const base = edit ? EXPECTED_MS.folax_edit : usesFolaxVideo(job) ? EXPECTED_MS.folax_video : usesFolax(job) ? EXPECTED_MS.folax : faceSwapEngineOf(job) === 'swapper' ? EXPECTED_MS.faceswap : upscaleOf(job) ? EXPECTED_MS.upscale : EXPECTED_MS[job.kind];
    const expected = base * (job.kind === 'video' && !usesFolaxVideo(job) ? Math.max(1, Number(job.request.seconds) / 5) ** 0.5 : 1);
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
    // automation jobs (n8n with a callback_url) do not notify the user's devices
    else if (this.d.push?.enabled || this.d.fcm?.enabled) void this.notifyFinished(row, view).catch((err) => this.d.log.error('media.push_failed', { jobId, err }));
  }

  /** Push to the owner's browsers and Android app; for an image batch only once, when its last job finishes. */
  private async notifyFinished(row: MediaJob, view: MediaJobView) {
    let batch: BatchOutcome | undefined;
    if (row.batchId) {
      const jobs = await this.d.db
        .select({ id: mediaJobs.id, status: mediaJobs.status })
        .from(mediaJobs)
        .where(and(eq(mediaJobs.batchId, row.batchId), isNull(mediaJobs.deletedAt)));
      if (jobs.some((j) => !isTerminal(j.status))) return;
      const done = jobs.filter((j) => j.status === 'completed');
      batch = { n: jobs.length, completed: done.length, openId: done[0]?.id ?? null };
    }
    await Promise.all([
      this.d.push?.enabled ? this.d.push.notify(row.userId, jobPushMessage(view, batch)) : null,
      this.d.fcm?.enabled ? this.d.fcm.notify(row.userId, jobFcmMessage(view, batch)) : null,
    ]);
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

  /** Qoder videos wait in the VIDEO_CONCURRENCY queue; images and Folax videos (the adapter limits itself) start at once. */
  private schedule(job: MediaJob) {
    if (job.kind === 'video' && !usesFolaxVideo(job)) this.enqueue(job.id);
    else void this.run(job);
  }

  private async resumeInProgress(job: MediaJob) {
    if (job.kind === 'video' && !usesFolaxVideo(job)) this.runningVideos.add(job.id);
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
      const outcome: Outcome = { fileIds: state.fileIds, credits: state.credits?.total ?? null, error: state.error };
      // a close-up face swap cut off during its Qoder turn still needs the paste-back step (and maybe retries)
      await this.finish(job.id, isCloseUpEngine(faceSwapEngineOf(job)) ? await this.completeFaceCrop(job, outcome) : outcome);
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
  if (DRAINING.test(output)) return { code: 'upstream_draining', message: 'Qoder generator instance was restarting (HTTP 423 draining); try again' };
  const detail = output.replace(/^\w+_gen error:\s*/i, '').replace(/request_id[:=]\S+/gi, '').slice(0, 300);
  return { code: 'generation_failed', message: `Generator error: ${detail}` };
}

/** Displayed pixel size of an image (EXIF orientations 5–8 swap width and height); empty when unreadable. */
async function imageSizeOf(path: string): Promise<{ width?: number; height?: number }> {
  try {
    const m = await sharp(path).metadata();
    const rotated = (m.orientation ?? 1) >= 5;
    return m.width && m.height ? (rotated ? { width: m.height, height: m.width } : { width: m.width, height: m.height }) : {};
  } catch {
    return {};
  }
}

/** Engine of a face swap job (phase-1 jobs without one were whole-photo Qoder edits); null for other jobs. */
function faceSwapEngineOf(job: MediaJob): FaceSwapEngine | null {
  const fs = job.request.face_swap as FaceSwapJobInfo | undefined;
  return fs ? (fs.engine ?? 'qoder') : null;
}

/** `request.upscale` of an upscale job, null for any other job. */
function upscaleOf(job: MediaJob): UpscaleJobInfo | null {
  return job.kind === 'image' && job.request.provider_used === 'upscale' ? ((job.request.upscale as UpscaleJobInfo | undefined) ?? null) : null;
}

/** Engines that let Qoder edit a close-up of the face and paste it back (sidecar crop → Qoder → sidecar paste). */
const isCloseUpEngine = (engine: FaceSwapEngine | null): engine is 'qoder_crop' | 'swapper_polish' => engine === 'qoder_crop' || engine === 'swapper_polish';

/** The face's image: recorded since phase 2, else the second input of a phase-1 job. */
function faceFileIdOf(job: MediaJob): string {
  const fs = job.request.face_swap as FaceSwapJobInfo;
  return fs.face_file_id ?? ((job.request.input_file_ids as string[] | undefined) ?? [])[1] ?? '';
}

const baseName = (filename: string) => filename.replace(/\.[^.]+$/, '').slice(0, 80) || 'image';
const extOf = (mime: string) => (mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg');

const usesFolax = (job: MediaJob) => job.kind === 'image' && job.request.provider_used === 'folax';
const usesFolaxVideo = (job: MediaJob) => job.kind === 'video' && job.request.provider_used === 'folax';

/** `request.folax` of a Folax video job: the adapter job and the upstream task (to resume after an adapter restart). */
interface FolaxVideoState {
  id: string;
  task_id: string | null;
  client_task_id: string | null;
}
/** The Folax edit mode of an image job, or null for any other job. */
function folaxEditOf(job: MediaJob): FolaxEditMode | null {
  const mode = usesFolax(job) ? (job.request.folax_edit as { mode?: unknown } | undefined)?.mode : undefined;
  return mode === 'instruction' ? mode : null;
}

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
