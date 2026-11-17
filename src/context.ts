import { AuthService } from './auth/auth.js';
import type { Config } from './config.js';
import { AgentPool } from './core/agentPool.js';
import { EventBus } from './core/bus.js';
import { ConversationService } from './core/conversations.js';
import { PromptEnhancer } from './core/enhancer.js';
import { QoderHousekeeper } from './core/housekeeping.js';
import { QoderCreditsService } from './core/qoderCredits.js';
import { ConversationTitler } from './core/titler.js';
import { MediaService } from './core/media.js';
import { ModelRegistry } from './core/models.js';
import { MediaStore } from './core/storage.js';
import { probeFfmpeg } from './core/variants.js';
import { TurnRunner } from './core/turns.js';
import { UsageService } from './core/usage.js';
import { WebhookService } from './core/webhooks.js';
import { type Database, openDatabase } from './db/client.js';
import { sha256 } from './ids.js';
import { createLogger, type Logger } from './log.js';
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
  media: MediaService;
  enhancer: PromptEnhancer;
  /** null when AUTO_TITLE=false. */
  titler: ConversationTitler | null;
  /** null when FOLAX_URL/FOLAX_API_KEY are unset. */
  folax: FolaxClient | null;
  webhooks: WebhookService;
  housekeeper: QoderHousekeeper;
  qoderCredits: QoderCreditsService;
  /** Start background work (model sync, media worker, webhook retries). */
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface ContextOverrides {
  log?: Logger;
  fetchImpl?: typeof fetch;
  /** Qoder retry backoff base (tests use a few ms). */
  qoderRetryBaseMs?: number;
}

export async function createContext(config: Config, o: ContextOverrides = {}): Promise<AppContext> {
  const log = o.log ?? createLogger(config.LOG_LEVEL);
  const database = await openDatabase(config.DATABASE_URL);
  const db = database.db;
  const tokens = config.QODER_SA_KEY
    ? serviceAccountTokenProvider(config.QODER_SA_KEY, config.QODER_OPENAPI_BASE_URL, o.fetchImpl)
    : patTokenProvider(config.QODER_PAT!);
  const qoder = new QoderClient({ baseUrl: config.QODER_BASE_URL, tokens, log: log.child({ mod: 'qoder' }), fetchImpl: o.fetchImpl, retryBaseMs: o.qoderRetryBaseMs });
  const bus = new EventBus();
  const agents = new AgentPool(db, qoder, log, config.QODER_ENVIRONMENT_ID);
  await agents.syncAccount(sha256(`${config.QODER_BASE_URL}\n${config.QODER_SA_KEY ?? config.QODER_PAT}`));
  const models = new ModelRegistry(db, qoder, config.MODEL_ALIASES, log.child({ mod: 'models' }));
  const ffmpeg = config.FFMPEG_PATH && (await probeFfmpeg(config.FFMPEG_PATH)) ? config.FFMPEG_PATH : null;
  if (!ffmpeg) log.warn('media.ffmpeg_unavailable', { path: config.FFMPEG_PATH, effect: 'videos get no thumbnail_url/preview_url' });
  const store = new MediaStore(db, config.MEDIA_DIR, config.PUBLIC_BASE_URL, config.MEDIA_SIGNING_SECRET!, config.MEDIA_URL_TTL_SEC, ffmpeg);
  const usage = new UsageService(db);
  const conversations = new ConversationService(db);
  const auth = new AuthService(db, config.JWT_SECRET);
  const webhooks = new WebhookService(db, log.child({ mod: 'webhooks' }), o.fetchImpl, { pollIntervalMs: config.WEBHOOK_POLL_INTERVAL_MS });
  const turns = new TurnRunner({ db, qoder, agents, models, store, usage, conversations, bus, log: log.child({ mod: 'turns' }), sessionBudgetCredits: config.SESSION_BUDGET_CREDITS });
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
  const enhancer = new PromptEnhancer({ conversations, turns, log: log.child({ mod: 'enhancer' }) });
  const titler = config.AUTO_TITLE ? new ConversationTitler({ db, conversations, turns, log: log.child({ mod: 'titler' }), model: 'titler' }) : null;
  const folax =
    config.FOLAX_URL && config.FOLAX_API_KEY
      ? new FolaxClient({ baseUrl: config.FOLAX_URL, apiKey: config.FOLAX_API_KEY, log: log.child({ mod: 'folax' }), fetchImpl: o.fetchImpl })
      : null;
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
    folax,
    defaultImageProvider: config.IMAGE_PROVIDER_DEFAULT,
    videoConcurrency: config.VIDEO_CONCURRENCY,
    pollIntervalMs: config.MEDIA_POLL_INTERVAL_MS,
    queueRetryDelaysMs: config.MEDIA_QUEUE_RETRY_DELAYS_MS,
  });

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
    media,
    enhancer,
    titler,
    folax,
    webhooks,
    housekeeper,
    qoderCredits,
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
      housekeeper.start();
    },
    async close() {
      if (timer) clearInterval(timer);
      housekeeper.stop();
      await media.stop();
      await webhooks.stop();
      await database.close();
    },
  };
}
