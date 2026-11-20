import { z } from 'zod';

const DEFAULT_ALIASES: Record<string, string[]> = {
  default: ['auto', 'efficient'],
  smart: ['ultimate', 'kmodel_latest', 'auto'],
  fast: ['fast', 'qfmodel', 'efficient'],
  cheap: ['efficient', 'qfmodel', 'dfmodel'],
  vision: ['auto', 'efficient'],
  // prompt enhancer: Qwen4-Max-Preview (~8 s, prompts as rich as Kimi-K3.1-Pro, which took ~27 s), then GLM-5.3 / DeepSeek-V4-Pro (~5 s)
  enhancer: ['qmodel_latest', 'gmodel', 'dmodel', 'kmodel_latest', 'auto', 'efficient'],
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
    /** Default PAT; an admin can override it (PUT /admin/qoder/credential). May be empty if an admin sets one. */
    QODER_PAT: optionalString(z.string().min(1)),
    QODER_SA_KEY: optionalString(z.string().min(1)),
    QODER_ENVIRONMENT_ID: z.string().optional(),
    /** qoder.com web dashboard API, used only to read the account's remaining credits. */
    QODER_WEB_BASE_URL: z.string().url().default('https://qoder.com'),
    /** Browser login cookie `qoder_session_cookie` for that API (PATs are rejected there). Admins can override it. */
    QODER_WEB_SESSION: optionalString(z.string().min(1)),
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
    /** How often a Folax video job is polled (the adapter recommends 15 s; a video takes ~2–2.5 min). */
    FOLAX_VIDEO_POLL_MS: z.coerce.number().int().min(10).default(15_000),
    /** How often the webhook worker looks for due deliveries/retries. */
    WEBHOOK_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(5000),
    /** Waits (ms, comma separated) before re-submitting a media job rejected by a full Qoder generation queue. */
    MEDIA_QUEUE_RETRY_DELAYS_MS: z
      .string()
      .default('30000,60000,120000,180000,300000')
      .transform((v) => v.split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n >= 0)),
    /** Waits (ms, comma separated) before re-submitting a media job whose generator hit a draining Qoder instance (HTTP 423). */
    MEDIA_DRAINING_RETRY_DELAYS_MS: z
      .string()
      .default('5000,15000,30000')
      .transform((v) => v.split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n >= 0)),
    SESSION_BUDGET_CREDITS: z.coerce.number().positive().optional(),
    /** Multi-agent runs (core/runs) executing at once; chat replies of virtual models (council) start regardless. */
    RUN_CONCURRENCY: z.coerce.number().int().min(1).default(4),
    /** Hidden Qoder/Folax turns of all runs in flight at once (kept apart from user chat turns). */
    RUN_TURN_CONCURRENCY: z.coerce.number().int().min(1).default(12),
    /** First backoff (ms) before a failed run step is retried; doubles per attempt. */
    RUN_RETRY_BASE_MS: z.coerce.number().int().min(1).default(1000),
    /** Council judges (aliases or model ids, comma separated); unavailable ones are skipped. */
    COUNCIL_JUDGES: z
      .string()
      .default('smart,kmodel_latest,gmodel')
      .transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean)),
    /** Model that writes the council's final answer from the best ones. */
    COUNCIL_SYNTHESIZER: z.string().trim().min(1).default('smart'),
    /** Deep research: plans and judges gaps / runs the web research agents / writes and edits the report. */
    RESEARCH_PLANNER: z.string().trim().min(1).default('smart'),
    RESEARCH_WORKER: z.string().trim().min(1).default('default'),
    RESEARCH_WRITER: z.string().trim().min(1).default('smart'),
    /** Short film: writes and revises the script. */
    FILM_WRITER: z.string().trim().min(1).default('smart'),
    /** Default retention: Qoder sessions idle longer than this are archived and their Qoder files deleted (local copies stay). Admins can override it. */
    QODER_RETENTION_HOURS: z.coerce.number().positive().default(24),
    /** Default interval of the Qoder housekeeping pass; 0 = disabled by default. Admins can override it. */
    QODER_HOUSEKEEPING_INTERVAL_HOURS: z.coerce.number().min(0).default(24),
    /** folax-adapter sidecar (fast external image generator); the provider is disabled when unset. */
    FOLAX_URL: optionalString(z.string().url()),
    FOLAX_API_KEY: optionalString(z.string().min(1)),
    /** Folax calls in flight at once (a batch of n runs n calls). Keep ≤ the adapter's `max_concurrency`. */
    FOLAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(8),
    /** faceswap sidecar (InsightFace swapper + face crop/paste), e.g. http://faceswap:8080; face swap engines swapper/swapper_polish/qoder_crop are off when unset. */
    FACESWAP_URL: optionalString(z.string().url()),
    /** Sent as X-API-Key; leave empty when the sidecar runs without auth. */
    FACESWAP_API_KEY: optionalString(z.string().min(1)),
    /** Sidecar calls in flight at once (CPU bound). */
    FACESWAP_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
    /** Per sidecar call. */
    FACESWAP_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),
    /** Head swap candidate Qoder turns in flight at once (all head swap jobs together; more wait in FIFO order). */
    HEAD_SWAP_TURN_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(6),
    /** Web Push (VAPID) for "your creation is ready" notifications in the PWA; off when the keys are unset. Generate with `npx web-push generate-vapid-keys`. */
    VAPID_PUBLIC_KEY: optionalString(z.string().min(20)),
    VAPID_PRIVATE_KEY: optionalString(z.string().min(20)),
    /** VAPID contact (`mailto:` or `https:` URL); defaults to PUBLIC_BASE_URL. */
    VAPID_SUBJECT: optionalString(z.string().regex(/^(mailto:|https:\/\/)/, 'must start with mailto: or https://')),
    /** Firebase Cloud Messaging (HTTP v1) for the native Android app: base64 of the Firebase service-account JSON (project_id, client_email, private_key); off when unset. */
    FCM_SERVICE_ACCOUNT_B64: optionalString(z.string().min(20)),
    /** GPU box for face swap (`/v1/swap` only; the sidecar with FACESWAP_DEVICE=cuda over ZeroTier), e.g. http://10.121.21.101:8090. Primary; the CPU fallback is FACESWAP_URL. */
    FACESWAP_GPU_URL: optionalString(z.string().url()),
    /** Sent as X-API-Key to the GPU box; empty = no auth. */
    FACESWAP_GPU_API_KEY: optionalString(z.string().min(1)),
    /** Per swap call on the GPU (includes waiting behind a running upscale there); past it the swap falls back to the CPU. */
    FACESWAP_GPU_TIMEOUT_MS: z.coerce.number().int().min(1000).default(90_000),
    /** GPU upscaler (the GPU sidecar on the GPU box, over ZeroTier), e.g. http://10.121.21.101:8090. Primary; the CPU fallback is FACESWAP_URL. */
    UPSCALE_GPU_URL: optionalString(z.string().url()),
    /** Sent as X-API-Key to the GPU upscaler; empty = no auth. */
    UPSCALE_GPU_API_KEY: optionalString(z.string().min(1)),
    /** Per upscale call on the GPU; past it the job falls back to the CPU. */
    UPSCALE_GPU_TIMEOUT_MS: z.coerce.number().int().min(1000).default(240_000),
    /** Per upscale call on the CPU sidecar (a 4.2 MP photo with faces takes minutes). */
    UPSCALE_CPU_TIMEOUT_MS: z.coerce.number().int().min(1000).default(600_000),
    IMAGE_PROVIDER_DEFAULT: z.enum(IMAGE_PROVIDERS).default('auto'),
    /** Auto-name native conversations from their first message (ChatGPT style). */
    AUTO_TITLE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
    /**
     * Non-streaming first replies only: how long the JSON response waits for the title so it can carry it. Streams never
     * wait: the title is sent as soon as it exists, while the reply is still running.
     */
    AUTO_TITLE_WAIT_MS: z.coerce.number().int().min(0).default(5000),
    /** How long the Qoder title turn may take before Folax (`folax/gemini`) names the conversation instead. */
    AUTO_TITLE_QODER_MS: z.coerce.number().int().min(1000).default(45_000),
    CORS_ORIGINS: z
      .string()
      .default('*')
      .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
    /**
     * Passkeys (WebAuthn). The RP ID is the frontend's domain; a passkey only works on that domain (and its subdomains),
     * so changing it later makes existing passkeys unusable. Default: the host of the first https entry of CORS_ORIGINS.
     */
    PASSKEY_RP_ID: optionalString(z.string().min(1)),
    /** Shown by the browser/OS when creating a passkey. */
    PASSKEY_RP_NAME: z.string().min(1).default('StillGPT'),
    /** Web origins allowed to use passkeys (comma-separated). Default: CORS_ORIGINS without "*". */
    PASSKEY_ORIGINS: optionalString(z.string().transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))),
    /** Native app (Flutter) passkeys, Android: the app's package name, e.g. `id.ayenz.stillgpt`. */
    PASSKEY_ANDROID_PACKAGE: optionalString(z.string().regex(/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/, 'PASSKEY_ANDROID_PACKAGE must look like com.example.app')),
    /**
     * SHA-256 fingerprints of the Android signing certificates (comma-separated, `AB:CD:…`): debug, upload/release and the
     * Play App Signing key. Each becomes an allowed passkey origin (`android:apk-key-hash:…`) and goes into assetlinks.json.
     */
    PASSKEY_ANDROID_CERT_SHA256: optionalString(
      z
        .string()
        .transform((v) => v.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))
        .pipe(z.array(z.string().regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/, 'each fingerprint must be 32 hex bytes separated by colons'))),
    ),
    /** iOS: `TEAMID.bundle.id` entries (comma-separated) for apple-app-site-association `webcredentials`. */
    PASSKEY_IOS_APP_IDS: optionalString(
      z
        .string()
        .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
        .pipe(z.array(z.string().regex(/^[A-Z0-9]{10}\.[\w.-]+$/, 'each iOS app id must be TEAMID.bundle.id'))),
    ),
    /** Cloudflare Turnstile secret; when set, password sign-in (POST /auth/login) needs a `turnstile_token`. */
    TURNSTILE_SECRET_KEY: optionalString(z.string().min(1)),
    /** Hostnames the widget may be solved on (comma-separated). Default: the hosts of CORS_ORIGINS. Keep localhost out of prod. */
    TURNSTILE_HOSTNAMES: optionalString(z.string().transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  })
  .refine((c) => !c.PASSKEY_ANDROID_PACKAGE === !c.PASSKEY_ANDROID_CERT_SHA256?.length, {
    message: 'Set both PASSKEY_ANDROID_PACKAGE and PASSKEY_ANDROID_CERT_SHA256 (or neither)',
  })
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
