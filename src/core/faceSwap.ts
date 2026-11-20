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
 * - `swapper_polish`: `swapper` first (kept as an internal file), then the `qoder_crop` flow on the swapped photo with
 *   `polish_prompt` (Qoder retouches the close-up for realism, the sidecar pastes it back onto the swapped photo).
 * - `head_swap`: a vision model describes the target's hair/expression/angle, K whole-photo Qoder candidates rebuild the
 *   head like the face, the sidecar (`/v1/head-composite`) aligns each one, runs the swapper on it, keeps Qoder's eyes and
 *   blends the head into the untouched original; the candidate with the lowest cost wins.
 */
export const FACE_SWAP_ENGINES = ['head_swap', 'swapper_polish', 'swapper', 'qoder', 'qoder_crop'] as const;
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

/**
 * Default prompt of the `qoder_crop` engine: image 1 is a square close-up of the target's face that gets pasted back
 * (landmark-aligned by the sidecar, so the framing must stay put).
 */
export const FACE_SWAP_CROP_PROMPT =
  'Make the person in image 1 look exactly like the person in image 2. Image 2 is a reference sheet of their face from many angles. ' +
  'Replace the face in image 1 with their face, so that anyone who knows them would recognise them, while keeping image 1\'s smile, ' +
  'head pose, hairstyle, hair accessories, clothing, lighting and background, and the exact same framing and crop. ' +
  'Do not add, remove or restyle bangs/fringe; keep the hairline and every hair strand of image 1 exactly. ' +
  'Photorealistic. Output a single square photo.';

/** Default prompt of the `swapper_polish` engine: image 1 is a close-up of the swapper's result, image 2 the face. */
export const FACE_SWAP_POLISH_PROMPT =
  'Photo retouch of a close-up crop. Image 1 is the photo to retouch; image 2 is a reference sheet of the same person from different ' +
  'angles. Make the face in image 1 look like a real, sharp, natural photograph of the person in image 2: refine the eyes, eyelids, ' +
  'nose, lips and skin so the likeness to image 2 is as strong as possible, with natural skin pores and fine detail. Keep the ' +
  'expression, head pose, hair strands, hair ornaments, clothing, lighting, colours, background and the exact framing of image 1. ' +
  'Output one square photo.';

/** Which image of the face a head swap candidate shows Qoder as image 2. */
export const HEAD_SWAP_REFERENCES = ['primary', 'portrait', 'combo'] as const;
export type HeadSwapReference = (typeof HEAD_SWAP_REFERENCES)[number];
/** Placeholders a head swap candidate template may use; filled from the target's description. */
export const HEAD_SWAP_PLACEHOLDERS = ['hair', 'expression', 'angle'] as const;
export type HeadTraits = Record<(typeof HEAD_SWAP_PLACEHOLDERS)[number], string>;

/** Head swap template "Q5": keeps the described hair, expression and angle of image 1, takes face and bangs of image 2. */
export const HEAD_SWAP_Q5_TEMPLATE =
  'Swap the face of the person in image 1 with the face of the person in image 2, so she looks exactly like the person in image 2: ' +
  'the same eyes, eyebrows, nose, mouth, face shape and bangs/fringe. ' +
  'Keep her head size, neck and the natural proportions of a real face: do not squash, widen or shrink the face. ' +
  'In image 1 she has {hair}: keep exactly that hair colour and the rest of that hairstyle, only give her the bangs of image 2. ' +
  'Her expression in image 1 is: {expression}. Keep that same expression. ' +
  'Keep everything else in image 1 exactly the same: head angle ({angle}), pose, clothes, background and lighting. ' +
  'Return one photo with the same composition as image 1, never a grid or collage.';

/** Head swap template "Q4" (no placeholders): image 2 is the identity reference. */
export const HEAD_SWAP_Q4_PROMPT =
  'Make the person in image 1 the same person as in image 2. Image 2 is the identity reference: copy her exact face (eyes, eyebrows, ' +
  'nose, mouth, cheeks, jaw, face shape), her skin and her bangs/fringe, so friends would recognise her instantly. Fit the new face ' +
  'naturally to the head in image 1 with real, unsquashed proportions. From image 1 keep: head angle and gaze, a similar expression, ' +
  'original hair colour, hairstyle and hair accessories, body, clothes, background, lighting and framing. Photorealistic, one single ' +
  'photo with the same composition as image 1, never a grid or collage.';

/** Vision prompt of the head swap describe step (one image: the target). */
export const HEAD_SWAP_DESCRIBE_PROMPT =
  'Look at the person in the attached photo and describe them for a photo editor, in short English phrases. ' +
  "hair: exact hair colour and how it is styled; expression: the facial expression precisely (e.g. 'wide open-mouth smile showing upper teeth'); " +
  'angle: head angle in a few words. Reply with JSON only, no code fences: {"hair": "…", "expression": "…", "angle": "…"}';

export interface HeadSwapCandidateSpec {
  /** Qoder prompt; `{hair}`, `{expression}` and `{angle}` are filled from the target's description. */
  template: string;
  /** `portrait`/`combo` fall back to `primary` when the face has no portrait. */
  reference: HeadSwapReference;
}

export interface HeadSwapSettings {
  /** One Qoder candidate per entry (1–6), all run in parallel per output image. */
  candidates: HeadSwapCandidateSpec[];
  describe_prompt: string;
  /** Swapper options of the sidecar's head composite (it swaps the identity into each Qoder candidate). */
  swapper: SwapperOptions;
  /** Blend the eyes of Qoder's candidate back over the swapper's result. */
  eye_keep: boolean;
}

export const HEAD_SWAP_MAX_CANDIDATES = 6;

export const DEFAULT_HEAD_SWAP_SETTINGS: HeadSwapSettings = {
  candidates: [
    { template: HEAD_SWAP_Q5_TEMPLATE, reference: 'portrait' },
    { template: HEAD_SWAP_Q5_TEMPLATE, reference: 'combo' },
    { template: HEAD_SWAP_Q4_PROMPT, reference: 'portrait' },
  ],
  describe_prompt: HEAD_SWAP_DESCRIBE_PROMPT,
  swapper: { target_faces: 'largest', identity_mode: 'average', det_thresh: 0.5, restorer: 'gfpgan', restore_blend: 0.8, codeformer_fidelity: 0.7 },
  eye_keep: true,
};

/** Unknown description values (the describe step failed): the templates still read naturally. */
const UNKNOWN_TRAITS: HeadTraits = { hair: 'the hair shown in image 1', expression: 'the expression shown in image 1', angle: 'as in image 1' };

/** A candidate template with its placeholders filled (`traits` null = the describe step failed). */
export function fillHeadSwapTemplate(template: string, traits: Partial<HeadTraits> | null | undefined): string {
  return template.replace(/\{(hair|expression|angle)\}/g, (_, k: keyof HeadTraits) => {
    const v = traits?.[k]?.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
    return v || UNKNOWN_TRAITS[k];
  });
}

/** Selection cost of a head swap candidate (lower is better): hair colour kept, expression kept, identity strong. */
export function headSwapCost(f: { hair_dE: number; d_expr: number; identity: number }): number {
  return Math.min(f.hair_dE, 40) / 10 + f.d_expr * 4 - f.identity * 2;
}

export interface FaceSwapSettings {
  default_engine: FaceSwapEngine;
  qoder_prompt: string;
  qoder_crop_prompt: string;
  polish_prompt: string;
  /** Crop side = crop_expand × the face's larger side. */
  crop_expand: number;
  swapper: SwapperOptions;
  head_swap: HeadSwapSettings;
}

export const DEFAULT_FACE_SWAP_SETTINGS: FaceSwapSettings = {
  default_engine: 'head_swap',
  qoder_prompt: FACE_SWAP_PROMPT,
  qoder_crop_prompt: FACE_SWAP_CROP_PROMPT,
  polish_prompt: FACE_SWAP_POLISH_PROMPT,
  crop_expand: 2.2,
  swapper: { target_faces: 'largest', identity_mode: 'average', det_thresh: 0.5, restorer: 'codeformer', restore_blend: 0.8, codeformer_fidelity: 0.7 },
  head_swap: DEFAULT_HEAD_SWAP_SETTINGS,
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
  polish_prompt: prompt,
  crop_expand: z.number().min(1.2).max(4),
};

const headTemplate = prompt.refine((t) => [...t.matchAll(/\{([A-Za-z_]+)\}/g)].every((m) => (HEAD_SWAP_PLACEHOLDERS as readonly string[]).includes(m[1]!)), {
  message: `placeholders must be one of ${HEAD_SWAP_PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}`,
});
const headSwapCandidate = z.object({ template: headTemplate, reference: z.enum(HEAD_SWAP_REFERENCES) }).strict();

const nullable = <T extends Record<string, z.ZodType>>(fields: T) =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.nullable().optional()])) as { [K in keyof T]: z.ZodOptional<z.ZodNullable<T[K]>> };

const swapperPatch = z.object(nullable(swapperFields)).strict();
const headSwapPatch = z
  .object({
    candidates: z.array(headSwapCandidate).min(1).max(HEAD_SWAP_MAX_CANDIDATES).nullable().optional(),
    describe_prompt: prompt.nullable().optional(),
    swapper: swapperPatch.nullable().optional(),
    eye_keep: z.boolean().nullable().optional(),
  })
  .strict();

/**
 * `PUT /admin/face-swap/settings`: any subset; `null` resets a field (or the whole `swapper` / `head_swap` block, or a
 * field inside `head_swap`) to its default. `head_swap.candidates` is replaced as a whole list.
 */
export const faceSwapSettingsPatch = z
  .object({ ...nullable(settingsFields), swapper: swapperPatch.nullable().optional(), head_swap: headSwapPatch.nullable().optional() })
  .strict();
export type FaceSwapSettingsPatch = z.infer<typeof faceSwapSettingsPatch>;

/** Overrides as stored in `kv` (only what differs from the built-in defaults, so new defaults apply to untouched fields). */
type HeadSwapOverrides = Partial<Omit<HeadSwapSettings, 'swapper'>> & { swapper?: Partial<SwapperOptions> };
type Overrides = Partial<Omit<FaceSwapSettings, 'swapper' | 'head_swap'>> & { swapper?: Partial<SwapperOptions>; head_swap?: HeadSwapOverrides };

/** Effective settings = defaults + a patch (without nulls, e.g. a test's `settings_override`). */
export function applyPatch(base: FaceSwapSettings, patch: FaceSwapSettingsPatch | undefined): FaceSwapSettings {
  if (!patch) return base;
  const { swapper, head_swap, ...top } = patch;
  const hs = head_swap ? stripNulls(head_swap) : {};
  return {
    ...base,
    ...stripNulls(top),
    swapper: { ...base.swapper, ...(swapper ? stripNulls(swapper) : {}) },
    head_swap: {
      ...base.head_swap,
      ...hs,
      swapper: { ...base.head_swap.swapper, ...(head_swap?.swapper ? stripNulls(head_swap.swapper) : {}) },
    },
  } as FaceSwapSettings;
}

/** Merge a patch into stored overrides: `null` deletes an override, nested objects merge, empty objects disappear. */
function mergeOverrides(current: Record<string, unknown>, patch: Record<string, unknown>, nested: string[]): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) delete next[k];
    else if (nested.includes(k) && typeof v === 'object' && !Array.isArray(v)) {
      const merged = mergeOverrides((next[k] as Record<string, unknown> | undefined) ?? {}, v as Record<string, unknown>, k === 'head_swap' ? ['swapper'] : []);
      if (Object.keys(merged).length) next[k] = merged;
      else delete next[k];
    } else next[k] = v;
  }
  return next;
}

const stripNulls = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;

export interface FaceSwapSidecarStatus {
  configured: boolean;
  ready: boolean;
  models?: Record<string, unknown>;
}

/**
 * Admin-editable face swap settings (`kv` key `face_swap.settings`), cached in memory, plus engine availability.
 * `head_swap`, `swapper`, `swapper_polish` and `qoder_crop` need the faceswap sidecar (configured and ready); `qoder` is always available.
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
    const next = mergeOverrides(this.overrides as Record<string, unknown>, r.data as Record<string, unknown>, ['swapper', 'head_swap']) as Overrides;
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
    return {
      head_swap: { available: sidecar },
      swapper_polish: { available: sidecar },
      swapper: { available: sidecar },
      qoder: { available: true },
      qoder_crop: { available: sidecar },
    };
  }
}
