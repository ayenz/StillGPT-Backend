import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { kv } from '../db/schema.js';
import { badRequest } from '../errors.js';
import type { Logger } from '../log.js';
import type { FaceSwapClient, SwapperOptions } from '../providers/faceswap.js';

/**
 * Face swap engines:
 * - `swapper`: the faceswap sidecar (InsightFace + inswapper + face restore). Free, deterministic, keeps resolution.
 * - `qoder`: a Qoder image edit of the whole photo (image 1 = target, image 2 = face).
 * - `qoder_crop`: the sidecar cuts a square around the target's face, Qoder edits that close-up at 1024x1024,
 *   the sidecar blends it back into the original photo.
 */
export const FACE_SWAP_ENGINES = ['swapper', 'qoder', 'qoder_crop'] as const;
export type FaceSwapEngine = (typeof FACE_SWAP_ENGINES)[number];

const KEEP_FROM_TARGET =
  'Keep everything else exactly as in image 1: the exact facial expression (smiling or not, visible teeth, how far the mouth is open, ' +
  'eye openness, eyebrow position), head angle and gaze direction, the hairstyle, hair length, hair colour, hairline, fringe/bangs and ' +
  'hair accessories (clips, bands, hats), makeup, glasses, jewellery, outfit, body, pose, hands, lighting, shadows, colour grading, ' +
  'background and image quality. Do not copy hair, expression, makeup, clothing or background from image 2.';

/** Default prompt of the whole-photo `qoder` engine. Image 1 = target, image 2 = face (portrait or 3x3 angle sheet). */
export const FACE_SWAP_PROMPT =
  'Face swap. Image 1 is the target photo to edit; image 2 shows the identity to use: a single portrait or a 3x3 sheet of the same person ' +
  'seen from different angles (use all views to understand the face). Replace only the facial identity of the person in image 1 with the ' +
  'person in image 2. Take ONLY these identity features from image 2: face shape, eyes, eyebrows, nose, lips, jawline, chin and skin tone, ' +
  `with the age of image 2. ${KEEP_FROM_TARGET} ` +
  'Blend the new face seamlessly into the lighting, skin texture and grain of image 1. Output a single photo with the same framing as image 1, ' +
  'not a grid or collage.';

/** Default prompt of the `qoder_crop` engine: image 1 is a square close-up of the target's face that gets pasted back. */
export const FACE_SWAP_CROP_PROMPT =
  'Face swap on a close-up. Image 1 is a square close-up crop around a face, cut from a larger photo; it will be pasted back into that ' +
  'photo, so keep its framing pixel-aligned: the same head position, size and angle, and leave the borders of the image unchanged. ' +
  'Image 2 shows the identity to use: a single portrait or a 3x3 sheet of the same person seen from different angles (use all views to ' +
  'understand the face). Replace only the facial identity of the person in image 1 with the person in image 2. Take ONLY these identity ' +
  `features from image 2: face shape, eyes, eyebrows, nose, lips, jawline, chin and skin tone. ${KEEP_FROM_TARGET} ` +
  'Do not zoom, crop, rotate or reframe. Match the lighting, skin texture, sharpness and grain of image 1. Output a single square photo, ' +
  'not a grid or collage.';

export interface FaceSwapSettings {
  default_engine: FaceSwapEngine;
  qoder_prompt: string;
  qoder_crop_prompt: string;
  /** Crop side = crop_expand × the face's larger side. */
  crop_expand: number;
  swapper: SwapperOptions;
}

export const DEFAULT_FACE_SWAP_SETTINGS: FaceSwapSettings = {
  default_engine: 'swapper',
  qoder_prompt: FACE_SWAP_PROMPT,
  qoder_crop_prompt: FACE_SWAP_CROP_PROMPT,
  crop_expand: 2.2,
  swapper: { target_faces: 'largest', identity_mode: 'average', det_thresh: 0.5, restorer: 'codeformer', restore_blend: 0.8, codeformer_fidelity: 0.7 },
};

export const FACE_SWAP_PROMPT_MAX = 4000;
const KEY = 'face_swap.settings';

const prompt = z.string().trim().min(20, 'must be at least 20 characters').max(FACE_SWAP_PROMPT_MAX, `must be at most ${FACE_SWAP_PROMPT_MAX} characters`);
const swapperFields = {
  target_faces: z.enum(['largest', 'all']),
  identity_mode: z.enum(['average', 'frontal']),
  det_thresh: z.number().min(0.1).max(0.95),
  restorer: z.enum(['codeformer', 'gfpgan', 'off']),
  restore_blend: z.number().min(0).max(1),
  codeformer_fidelity: z.number().min(0).max(1),
};
const settingsFields = {
  default_engine: z.enum(FACE_SWAP_ENGINES),
  qoder_prompt: prompt,
  qoder_crop_prompt: prompt,
  crop_expand: z.number().min(1.2).max(4),
};

const nullable = <T extends Record<string, z.ZodType>>(fields: T) =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.nullable().optional()])) as { [K in keyof T]: z.ZodOptional<z.ZodNullable<T[K]>> };

/** `PUT /admin/face-swap/settings`: any subset; `null` resets a field (or the whole `swapper` block) to its default. */
export const faceSwapSettingsPatch = z
  .object({ ...nullable(settingsFields), swapper: z.object(nullable(swapperFields)).strict().nullable().optional() })
  .strict();
export type FaceSwapSettingsPatch = z.infer<typeof faceSwapSettingsPatch>;

/** Overrides as stored in `kv` (only what differs from the built-in defaults, so new defaults apply to untouched fields). */
type Overrides = Partial<Omit<FaceSwapSettings, 'swapper'>> & { swapper?: Partial<SwapperOptions> };

/** Effective settings = defaults + a patch (without nulls, e.g. a test's `settings_override`). */
export function applyPatch(base: FaceSwapSettings, patch: FaceSwapSettingsPatch | undefined): FaceSwapSettings {
  if (!patch) return base;
  const { swapper, ...top } = patch;
  return {
    ...base,
    ...stripNulls(top),
    swapper: { ...base.swapper, ...(swapper ? stripNulls(swapper) : {}) },
  } as FaceSwapSettings;
}

const stripNulls = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;

export interface FaceSwapSidecarStatus {
  configured: boolean;
  ready: boolean;
  models?: Record<string, unknown>;
}

/**
 * Admin-editable face swap settings (`kv` key `face_swap.settings`), cached in memory, plus engine availability.
 * `swapper` and `qoder_crop` need the faceswap sidecar (configured and ready); `qoder` is always available.
 */
export class FaceSwapSettingsService {
  private overrides: Overrides = {};

  constructor(private readonly d: { db: DB; log: Logger; client: FaceSwapClient | null }) {}

  async load(): Promise<void> {
    const [row] = await this.d.db.select().from(kv).where(eq(kv.key, KEY));
    const parsed = faceSwapSettingsPatch.safeParse(row?.value ?? {});
    if (parsed.success) this.overrides = stripNulls(parsed.data) as Overrides;
    else this.d.log.warn('face_swap.settings_invalid', { issues: parsed.error.issues.length });
  }

  get(): FaceSwapSettings {
    return applyPatch(DEFAULT_FACE_SWAP_SETTINGS, this.overrides as FaceSwapSettingsPatch);
  }

  /** Partial merge; `null` removes an override. Throws 400 `validation_error` on bad values. */
  async update(input: unknown): Promise<FaceSwapSettings> {
    const r = faceSwapSettingsPatch.safeParse(input);
    if (!r.success) {
      const issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      throw badRequest(issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; '), 'validation_error', { issues });
    }
    const { swapper, ...top } = r.data;
    const next: Overrides = { ...this.overrides };
    for (const [k, v] of Object.entries(top) as [keyof typeof top, unknown][]) {
      if (v === null) delete next[k];
      else if (v !== undefined) (next as Record<string, unknown>)[k] = v;
    }
    if (swapper === null) delete next.swapper;
    else if (swapper) {
      const s: Partial<SwapperOptions> = { ...next.swapper };
      for (const [k, v] of Object.entries(swapper) as [keyof SwapperOptions, unknown][]) {
        if (v === null) delete s[k];
        else if (v !== undefined) (s as Record<string, unknown>)[k] = v;
      }
      if (Object.keys(s).length) next.swapper = s;
      else delete next.swapper;
    }
    if (Object.keys(next).length) {
      await this.d.db
        .insert(kv)
        .values({ key: KEY, value: next })
        .onConflictDoUpdate({ target: kv.key, set: { value: next, updatedAt: new Date() } });
    } else {
      await this.d.db.delete(kv).where(eq(kv.key, KEY));
    }
    this.overrides = next;
    this.d.log.info('face_swap.settings_updated', { fields: Object.keys(next) });
    return this.get();
  }

  async sidecar(fresh = false): Promise<FaceSwapSidecarStatus> {
    if (!this.d.client) return { configured: false, ready: false };
    const r = await this.d.client.readiness(fresh);
    return { configured: true, ready: r.ready, ...(r.models ? { models: r.models } : {}) };
  }

  /** Whether `engine` can run now (sidecar engines need it configured and ready; readiness is cached ~30 s). */
  async available(engine: FaceSwapEngine, o: { recheck?: boolean } = {}): Promise<boolean> {
    if (engine === 'qoder') return true;
    if (!this.d.client) return false;
    if (await this.d.client.ready()) return true;
    // a cached "not ready" may be stale (the sidecar was still loading models): probe again before refusing a request
    return o.recheck ? this.d.client.ready(true) : false;
  }

  async engines(): Promise<Record<FaceSwapEngine, { available: boolean }>> {
    const sidecar = await this.available('swapper');
    return { swapper: { available: sidecar }, qoder: { available: true }, qoder_crop: { available: sidecar } };
  }
}
