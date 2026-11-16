import { z } from 'zod';

const DEFAULT_ALIASES: Record<string, string[]> = {
  default: ['auto', 'efficient'],
  smart: ['ultimate', 'kmodel_latest', 'auto'],
  fast: ['fast', 'qfmodel', 'efficient'],
  cheap: ['efficient', 'qfmodel', 'dfmodel'],
  vision: ['auto', 'efficient'],
  // prompt enhancer: Kimi-K3.1-Pro first (quality > latency here), Qwen4-Max-Preview as fast fallback — same as the n8n bot
  enhancer: ['kmodel_latest', 'qmodel_latest', 'kmodel', 'auto', 'efficient'],
  // auto chat titles: fastest models first (DeepSeek-V4 Flash ~2 s, Qwen fast)
  titler: ['dfmodel', 'qfmodel', 'fast', 'efficient'],
};

const profileName = z.enum(['chat', 'assistant']);

export const IMAGE_PROVIDERS = ['auto', 'qoder', 'folax'] as const;
export type ImageProvider = (typeof IMAGE_PROVIDERS)[number];

/** Compose files often pass unset variables as empty strings. */
const optionalString = <T extends z.ZodType>(inner: T) => z.preprocess((v) => (v === '' ? undefined : v), inner.optional());

const schema = z
  .object({
    PORT: z.coerce.number().int().default(8790),
    PUBLIC_BASE_URL: z.string().url().default('http://localhost:8790'),
    DATABASE_URL: z.string().default('pglite://./data/pglite'),
    QODER_BASE_URL: z.string().url().default('https://api.qoder.com/api/v1/cloud'),
    QODER_OPENAPI_BASE_URL: z.string().url().default('https://openapi.qoder.sh'),
    QODER_PAT: z.string().optional(),
    QODER_SA_KEY: z.string().optional(),
    QODER_ENVIRONMENT_ID: z.string().optional(),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
    MEDIA_DIR: z.string().default('./data/media'),
    MEDIA_SIGNING_SECRET: z.string().min(16).optional(),
    MEDIA_URL_TTL_SEC: z.coerce.number().int().default(7 * 24 * 3600),
    /** ffmpeg binary for video thumbnails/posters. Set to an empty string to disable them. */
    FFMPEG_PATH: z.string().default('ffmpeg'),
    ADMIN_EMAIL: z.string().email().optional(),
    ADMIN_PASSWORD: z.string().min(8).optional(),
    DEFAULT_PROFILE_NATIVE: profileName.default('assistant'),
    DEFAULT_PROFILE_COMPAT: profileName.default('chat'),
    MODEL_ALIASES: z
      .string()
      .optional()
      .transform((v, ctx) => {
        if (!v) return DEFAULT_ALIASES;
        try {
          return { ...DEFAULT_ALIASES, ...(JSON.parse(v) as Record<string, string[]>) };
        } catch {
          ctx.addIssue({ code: 'custom', message: 'MODEL_ALIASES must be JSON {alias: [model ids]}' });
          return z.NEVER;
        }
      }),
    MODEL_SYNC_INTERVAL_MIN: z.coerce.number().default(60),
    VIDEO_CONCURRENCY: z.coerce.number().int().min(1).default(1),
    /** Media job progress ticks + restart-recovery polling. */
    MEDIA_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(5000),
    /** How often the webhook worker looks for due deliveries/retries. */
    WEBHOOK_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(5000),
    /** Waits (ms, comma separated) before re-submitting a media job rejected by a full Qoder generation queue. */
    MEDIA_QUEUE_RETRY_DELAYS_MS: z
      .string()
      .default('30000,60000,120000,180000,300000')
      .transform((v) => v.split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n >= 0)),
    SESSION_BUDGET_CREDITS: z.coerce.number().positive().optional(),
    /** Qoder sessions idle longer than this are archived and their Qoder files deleted (local copies stay). */
    QODER_RETENTION_HOURS: z.coerce.number().positive().default(24),
    /** How often the Qoder housekeeping pass runs; 0 disables it. */
    QODER_HOUSEKEEPING_INTERVAL_HOURS: z.coerce.number().min(0).default(24),
    /** folax-adapter sidecar (fast external image generator); the provider is disabled when unset. */
    FOLAX_URL: optionalString(z.string().url()),
    FOLAX_API_KEY: optionalString(z.string().min(1)),
    IMAGE_PROVIDER_DEFAULT: z.enum(IMAGE_PROVIDERS).default('auto'),
    /** Auto-name native conversations from their first message (ChatGPT style). */
    AUTO_TITLE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
    /** How long the first reply's `turn.completed` waits for the title before finishing without it. */
    AUTO_TITLE_WAIT_MS: z.coerce.number().int().min(0).default(5000),
    CORS_ORIGINS: z
      .string()
      .default('*')
      .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  })
  .refine((c) => c.QODER_PAT || c.QODER_SA_KEY, { message: 'Set QODER_PAT or QODER_SA_KEY' })
  .refine((c) => !c.FOLAX_URL === !c.FOLAX_API_KEY, { message: 'Set both FOLAX_URL and FOLAX_API_KEY (or neither)' })
  .refine((c) => c.IMAGE_PROVIDER_DEFAULT !== 'folax' || c.FOLAX_URL, { message: 'IMAGE_PROVIDER_DEFAULT=folax needs FOLAX_URL and FOLAX_API_KEY' });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  const cfg = parsed.data;
  return { ...cfg, MEDIA_SIGNING_SECRET: cfg.MEDIA_SIGNING_SECRET ?? cfg.JWT_SECRET };
}
