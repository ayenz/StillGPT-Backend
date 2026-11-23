import { AuthService } from './auth/auth.js';
import { PasskeyService, passkeyConfig } from './auth/passkeys.js';
import { TurnstileVerifier, turnstileConfig } from './auth/turnstile.js';
import type { Config } from './config.js';
import { AgentPool } from './core/agentPool.js';
import { EventBus } from './core/bus.js';
import { ConversationService } from './core/conversations.js';
import { PromptEnhancer } from './core/enhancer.js';
import { EnhancerInstructions } from './core/enhancerInstructions.js';
import { FaceService } from './core/faces.js';
import { FaceSwapSettingsService } from './core/faceSwap.js';
import { ReferenceReader } from './core/references.js';
import { PromptVariator } from './core/variations.js';
import { QoderHousekeeper } from './core/housekeeping.js';
import { MediaHousekeeper } from './core/mediaHousekeeping.js';
import { QoderCredentialService } from './core/qoderCredential.js';
import { QoderCreditsService } from './core/qoderCredits.js';
import { ConversationTitler } from './core/titler.js';
import { councilKind } from './core/runs/council.js';
import { researchKind } from './core/runs/research.js';
import { type FilmAssembler, FfmpegAssembler } from './core/runs/assembler.js';
import { filmKind } from './core/runs/film.js';
import { RunService } from './core/runs/service.js';
import { MediaService } from './core/media.js';
import { ModelRegistry } from './core/models.js';
import { MediaTrash } from './core/trash.js';
import { MediaStore } from './core/storage.js';
import { probeFfmpeg } from './core/variants.js';
import { TurnRunner } from './core/turns.js';
import { UsageService } from './core/usage.js';
import { WebhookService } from './core/webhooks.js';
import { type Database, openDatabase } from './db/client.js';
import { createLogger, type Logger } from './log.js';
import { type PushSender, PushService } from './core/push.js';
import { FcmService, parseServiceAccount } from './core/fcm.js';
import { FaceSwapClient } from './providers/faceswap.js';
import { UpscaleClient } from './providers/upscale.js';
import { AppError } from './errors.js';
import { FolaxClient } from './providers/folax.js';
import { QoderClient } from './qoder/client.js';
import { patTokenProvider, serviceAccountTokenProvider } from './qoder/tokens.js';

/** Every service, wired once. Routes and tests receive this instead of importing singletons. */
export interface AppContext {
  config: Config;
  log: Logger;
  database: Database;
  qoder: QoderClient;
  agents: AgentPool;
  models: ModelRegistry;
  store: MediaStore;
  usage: UsageService;
  conversations: ConversationService;
  turns: TurnRunner;
  bus: EventBus;
  auth: AuthService;
  passkeys: PasskeyService;
  /** null when TURNSTILE_SECRET_KEY is unset (password sign-in then needs no human check). */
  turnstile: TurnstileVerifier | null;
  media: MediaService;
  /** Saved faces for face swap. */
  faces: FaceService;
  /** null when FACESWAP_URL is unset. */
  faceswap: FaceSwapClient | null;
  /** Admin face swap settings + engine availability. */
  faceSwapSettings: FaceSwapSettingsService;
  /** Image upscaler (GPU primary, CPU faceswap sidecar fallback); null when neither UPSCALE_GPU_URL nor FACESWAP_URL is set. */
  upscaler: UpscaleClient | null;
  enhancer: PromptEnhancer;
  enhancerInstructions: EnhancerInstructions;
  variator: PromptVariator;
  /** null when AUTO_TITLE=false. */
  titler: ConversationTitler | null;
  /** null when FOLAX_URL/FOLAX_API_KEY are unset. */
  folax: FolaxClient | null;
  webhooks: WebhookService;
  /** Web Push to the PWA; `enabled` is false without VAPID keys. */
  push: PushService;
  /** FCM to the native Android app; `enabled` is false without FCM_SERVICE_ACCOUNT_B64. */
  fcm: FcmService;
  housekeeper: QoderHousekeeper;
  /** Gallery trash (soft delete, restore, purge). */
  trash: MediaTrash;
  /** Local media housekeeping (trash grace period, old failed jobs, archived chats, unused uploads). */
  mediaHousekeeper: MediaHousekeeper;
  qoderCredits: QoderCreditsService;
  qoderCredential: QoderCredentialService;
  /** Multi-agent runs (council…) and the virtual chat models built on them. */
  runs: RunService;
  /** Start background work (model sync, media worker, webhook retries). */
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface ContextOverrides {
  log?: Logger;
  fetchImpl?: typeof fetch;
  /** Qoder retry backoff base (tests use a few ms). */
  qoderRetryBaseMs?: number;
  /** Replaces the Web Push sender (tests). */
  pushSender?: PushSender;
  /** fetch for FCM only (OAuth + messages:send); defaults to `fetchImpl` (tests). */
  fcmFetch?: typeof fetch;
  /** Replaces the ffmpeg film assembler (tests). */
  filmAssembler?: FilmAssembler;
}

export async function createContext(config: Config, o: ContextOverrides = {}): Promise<AppContext> {
  const log = o.log ?? createLogger(config.LOG_LEVEL);
  const database = await openDatabase(config.DATABASE_URL);
  const db = database.db;
  const qoderLog = log.child({ mod: 'qoder' });
  const qoderCredential = new QoderCredentialService({
    db,
    log: qoderLog,
    baseUrl: config.QODER_BASE_URL,
    envPat: config.QODER_PAT,
    saKey: config.QODER_SA_KEY,
    saProvider: config.QODER_SA_KEY ? serviceAccountTokenProvider(config.QODER_SA_KEY, config.QODER_OPENAPI_BASE_URL, o.fetchImpl) : undefined,
    environmentPinned: !!config.QODER_ENVIRONMENT_ID,
    // a throwaway client on the candidate PAT, no retries: fails fast on 401
    probe: async (pat) => {
      await new QoderClient({ baseUrl: config.QODER_BASE_URL, tokens: patTokenProvider(pat), log: qoderLog, fetchImpl: o.fetchImpl, maxRetries: 0 }).listEnvironments();
    },
  });
  await qoderCredential.load();
  const qoder = new QoderClient({ baseUrl: config.QODER_BASE_URL, tokens: qoderCredential, log: qoderLog, fetchImpl: o.fetchImpl, retryBaseMs: o.qoderRetryBaseMs });
  const bus = new EventBus();
  const agents = new AgentPool(db, qoder, log, config.QODER_ENVIRONMENT_ID);
  const fingerprint = qoderCredential.fingerprint();
  if (fingerprint) await agents.syncAccount(fingerprint);
  else log.warn('qoder.not_configured', { effect: 'Qoder calls fail until an admin sets a PAT via PUT /admin/qoder/credential' });
  const models = new ModelRegistry(db, qoder, config.MODEL_ALIASES, log.child({ mod: 'models' }));
  // A different account has its own environment, agents and possibly models.
  qoderCredential.onChange = async (fp) => {
    if (fp) await agents.syncAccount(fp);
    await models.sync().catch((err) => log.warn('models.sync_failed', { err }));
  };
  const ffmpeg = config.FFMPEG_PATH && (await probeFfmpeg(config.FFMPEG_PATH)) ? config.FFMPEG_PATH : null;
  if (!ffmpeg) log.warn('media.ffmpeg_unavailable', { path: config.FFMPEG_PATH, effect: 'videos get no thumbnail_url/preview_url' });
  const store = new MediaStore(db, config.MEDIA_DIR, config.PUBLIC_BASE_URL, config.MEDIA_SIGNING_SECRET!, config.MEDIA_URL_TTL_SEC, ffmpeg);
  const usage = new UsageService(db);
  const conversations = new ConversationService(db);
  const auth = new AuthService(db, config.JWT_SECRET);
  const passkeys = new PasskeyService({ db, auth, log: log.child({ mod: 'passkeys' }), config: passkeyConfig(config) });
  const turnstileCfg = turnstileConfig(config);
  const turnstile = turnstileCfg ? new TurnstileVerifier(turnstileCfg, log.child({ mod: 'turnstile' }), o.fetchImpl) : null;
  const webhooks = new WebhookService(db, log.child({ mod: 'webhooks' }), o.fetchImpl, { pollIntervalMs: config.WEBHOOK_POLL_INTERVAL_MS });
  const push = new PushService({
    db,
    log: log.child({ mod: 'push' }),
    config:
      config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY
        ? { publicKey: config.VAPID_PUBLIC_KEY, privateKey: config.VAPID_PRIVATE_KEY, subject: config.VAPID_SUBJECT ?? config.PUBLIC_BASE_URL }
        : null,
    sender: o.pushSender,
  });
  const fcm = new FcmService({
    db,
    log: log.child({ mod: 'fcm' }),
    account: config.FCM_SERVICE_ACCOUNT_B64 ? parseServiceAccount(config.FCM_SERVICE_ACCOUNT_B64) : null,
    fetchImpl: o.fcmFetch ?? o.fetchImpl,
  });
  const folax =
    config.FOLAX_URL && config.FOLAX_API_KEY
      ? new FolaxClient({
          baseUrl: config.FOLAX_URL,
          apiKey: config.FOLAX_API_KEY,
          concurrency: config.FOLAX_CONCURRENCY,
          log: log.child({ mod: 'folax' }),
          fetchImpl: o.fetchImpl,
        })
      : null;
  models.folaxEnabled = !!folax;
  const turns = new TurnRunner({ db, qoder, agents, models, store, usage, conversations, bus, log: log.child({ mod: 'turns' }), sessionBudgetCredits: config.SESSION_BUDGET_CREDITS, folax });
  const housekeeper = new QoderHousekeeper({
    db,
    qoder,
    log: log.child({ mod: 'housekeeping' }),
    // Env values are defaults until an admin saves settings (PATCH /admin/housekeeping).
    defaults: {
      enabled: config.QODER_HOUSEKEEPING_INTERVAL_HOURS > 0,
      retentionHours: config.QODER_RETENTION_HOURS,
      intervalHours: config.QODER_HOUSEKEEPING_INTERVAL_HOURS > 0 ? config.QODER_HOUSEKEEPING_INTERVAL_HOURS : 24,
    },
  });
  const qoderCredits = new QoderCreditsService({
    db,
    log: log.child({ mod: 'qoder_credits' }),
    baseUrl: config.QODER_WEB_BASE_URL,
    envSession: config.QODER_WEB_SESSION,
    fetchImpl: o.fetchImpl,
  });
  const enhancerInstructions = new EnhancerInstructions({ db, log: log.child({ mod: 'enhancer' }) });
  await enhancerInstructions.load();
  const references = new ReferenceReader({ conversations, turns, store, log: log.child({ mod: 'references' }) });
  const enhancer = new PromptEnhancer({ conversations, turns, log: log.child({ mod: 'enhancer' }), instructions: enhancerInstructions, references, folax, qoderWaitMs: config.ENHANCER_QODER_MS });
  const variator = new PromptVariator({ conversations, turns, references, log: log.child({ mod: 'variations' }), instructions: enhancerInstructions });
  const titler = config.AUTO_TITLE ? new ConversationTitler({ db, conversations, turns, log: log.child({ mod: 'titler' }), model: 'titler', folax, qoderWaitMs: config.AUTO_TITLE_QODER_MS }) : null;
  const faceswap = config.FACESWAP_URL
    ? new FaceSwapClient({
        baseUrl: config.FACESWAP_URL,
        apiKey: config.FACESWAP_API_KEY,
        concurrency: config.FACESWAP_CONCURRENCY,
        timeoutMs: config.FACESWAP_TIMEOUT_MS,
        gpu: config.FACESWAP_GPU_URL ? { baseUrl: config.FACESWAP_GPU_URL, apiKey: config.FACESWAP_GPU_API_KEY, timeoutMs: config.FACESWAP_GPU_TIMEOUT_MS } : undefined,
        log: log.child({ mod: 'faceswap' }),
        fetchImpl: o.fetchImpl,
      })
    : null;
  const upscaler =
    config.UPSCALE_GPU_URL || config.FACESWAP_URL
      ? new UpscaleClient({
          gpu: config.UPSCALE_GPU_URL ? { baseUrl: config.UPSCALE_GPU_URL, apiKey: config.UPSCALE_GPU_API_KEY, timeoutMs: config.UPSCALE_GPU_TIMEOUT_MS } : undefined,
          cpu: config.FACESWAP_URL ? { baseUrl: config.FACESWAP_URL, apiKey: config.FACESWAP_API_KEY, timeoutMs: config.UPSCALE_CPU_TIMEOUT_MS } : undefined,
          log: log.child({ mod: 'upscale' }),
          fetchImpl: o.fetchImpl,
        })
      : null;
  const faceSwapSettings = new FaceSwapSettingsService({ db, log: log.child({ mod: 'face_swap' }), client: faceswap });
  await faceSwapSettings.load();
  const media = new MediaService({
    db,
    qoder,
    conversations,
    turns,
    store,
    usage,
    webhooks,
    bus,
    log: log.child({ mod: 'media' }),
    enhancer,
    variator,
    folax,
    faceswap,
    faceSwapSettings,
    references,
    headSwapConcurrency: config.HEAD_SWAP_TURN_CONCURRENCY,
    upscaler,
    push,
    fcm,
    defaultImageProvider: config.IMAGE_PROVIDER_DEFAULT,
    videoConcurrency: config.VIDEO_CONCURRENCY,
    pollIntervalMs: config.MEDIA_POLL_INTERVAL_MS,
    folaxVideoPollMs: config.FOLAX_VIDEO_POLL_MS,
    queueRetryDelaysMs: config.MEDIA_QUEUE_RETRY_DELAYS_MS,
    drainingRetryDelaysMs: config.MEDIA_DRAINING_RETRY_DELAYS_MS,
  });
  // a Folax call that shows the shared token is rejected → admin webhook provider.degraded (throttled with generate-all's)
  // (webhook code folax_auth_invalid / folax_not_configured, same shape as generate-all's)
  if (folax) folax.onDown = (err) => media.reportDegraded('folax', new AppError(err.status, `folax_${String(err.details?.folax_code)}`, err.message));
  const faces = new FaceService({ db, store });
  const trash = new MediaTrash({ db, store, media, log: log.child({ mod: 'trash' }) });
  const mediaHousekeeper = new MediaHousekeeper({ db, trash, log: log.child({ mod: 'media_housekeeping' }) });

  const runService = new RunService({
    db,
    turns,
    conversations,
    bus,
    log: log.child({ mod: 'runs' }),
    store,
    media,
    push,
    fcm,
    webhooks,
    runConcurrency: config.RUN_CONCURRENCY,
    turnConcurrency: config.RUN_TURN_CONCURRENCY,
    retryBaseMs: config.RUN_RETRY_BASE_MS,
  });
  runService.register(councilKind({ db, models, folax, judges: config.COUNCIL_JUDGES, synthesizer: config.COUNCIL_SYNTHESIZER }));
  runService.registerVirtualModel('council', 'council', ({ content, preamble }) => ({ content, preamble, mode: 'synthesize' }));
  runService.registerVirtualModel('council-debate', 'council', ({ content, preamble }) => ({ content, preamble, mode: 'debate' }));
  runService.register(researchKind({ store, planner: config.RESEARCH_PLANNER, worker: config.RESEARCH_WORKER, writer: config.RESEARCH_WRITER }));
  runService.registerVirtualModel('research', 'research', ({ content, preamble }) => ({ content, preamble, depth: 'standard', formats: ['pdf', 'docx'] }));
  runService.registerVirtualModel('research-deep', 'research', ({ content, preamble }) => ({ content, preamble, depth: 'deep', formats: ['pdf', 'docx'] }));
  runService.register(
    filmKind({
      media,
      store,
      faces,
      assembler: o.filmAssembler ?? (ffmpeg ? new FfmpegAssembler(ffmpeg) : null),
      writer: config.FILM_WRITER,
      vision: 'vision',
    }),
  );

  models.onChange = (changes) => {
    for (const c of changes) void webhooks.emit(null, c.type, { model: { id: c.model.id, display_name: c.model.displayName }, ...('previous' in c ? { previous: c.previous } : {}) });
  };

  let timer: NodeJS.Timeout | undefined;
  return {
    config,
    log,
    database,
    qoder,
    agents,
    models,
    store,
    usage,
    conversations,
    turns,
    bus,
    auth,
    passkeys,
    turnstile,
    media,
    faces,
    faceswap,
    faceSwapSettings,
    upscaler,
    enhancer,
    enhancerInstructions,
    variator,
    titler,
    folax,
    webhooks,
    push,
    fcm,
    housekeeper,
    trash,
    mediaHousekeeper,
    qoderCredits,
    qoderCredential,
    runs: runService,
    async start() {
      await auth.ensureAdmin(config.ADMIN_EMAIL, config.ADMIN_PASSWORD);
      await models.load();
      await turns.recoverAbandoned();
      await models.sync().catch((err) => log.error('models.initial_sync_failed', { err }));
      if (config.MODEL_SYNC_INTERVAL_MIN > 0) {
        timer = setInterval(() => void models.sync().catch((err) => log.warn('models.sync_failed', { err })), config.MODEL_SYNC_INTERVAL_MIN * 60_000);
        timer.unref();
      }
      webhooks.start();
      media.start();
      await runService.start();
      housekeeper.start();
      mediaHousekeeper.start();
    },
    async close() {
      if (timer) clearInterval(timer);
      housekeeper.stop();
      mediaHousekeeper.stop();
      await runService.stop();
      await media.stop();
      await webhooks.stop();
      await database.close();
    },
  };
}
