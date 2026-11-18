import { boolean, doublePrecision, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();

// ── accounts ────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'),
  displayName: text('display_name'),
  role: text('role', { enum: ['admin', 'user'] }).notNull().default('user'),
  /** Credits per calendar month (UTC); null = unlimited. */
  monthlyCreditLimit: doublePrecision('monthly_credit_limit'),
  createdAt: createdAt(),
  disabledAt: ts('disabled_at'),
});

export const refreshTokens = pgTable('refresh_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
  createdAt: createdAt(),
});

export const apiKeys = pgTable('api_keys', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** First characters of the key, shown in UIs so users can tell keys apart. */
  prefix: text('prefix').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  lastUsedAt: ts('last_used_at'),
  revokedAt: ts('revoked_at'),
  createdAt: createdAt(),
});

// ── upstream mirrors ────────────────────────────────────────────────────────

/** Mirror of Qoder `GET /models`, kept in sync by ModelRegistry. */
export const models = pgTable('models', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  status: text('status', { enum: ['active', 'retired'] }).notNull().default('active'),
  priceFactor: doublePrecision('price_factor'),
  isVision: boolean('is_vision').notNull().default(false),
  isNew: boolean('is_new').notNull().default(false),
  efforts: jsonb('efforts').$type<string[]>(),
  defaultEffort: text('default_effort'),
  maxInputTokens: integer('max_input_tokens'),
  defaultContextWindow: integer('default_context_window'),
  raw: jsonb('raw').$type<Record<string, unknown>>().notNull(),
  firstSeenAt: createdAt(),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  retiredAt: ts('retired_at'),
});

/** One Qoder agent per profile (tool set). */
export const qoderAgents = pgTable('qoder_agents', {
  profile: text('profile').primaryKey(),
  agentId: text('agent_id').notNull(),
  model: text('model').notNull(),
  tools: jsonb('tools').$type<string[]>().notNull(),
  createdAt: createdAt(),
});

export const kv = pgTable('kv', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

// ── conversations ───────────────────────────────────────────────────────────

export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    title: text('title'),
    profile: text('profile').notNull(),
    /** What the client asked for (alias or id). */
    model: text('model').notNull(),
    /** Qoder model id currently applied to the session. */
    resolvedModel: text('resolved_model'),
    systemPrompt: text('system_prompt'),
    qoderSessionId: text('qoder_session_id'),
    /** Last upstream event id we processed — used as Last-Event-ID. */
    lastEventId: text('last_event_id'),
    status: text('status', { enum: ['idle', 'busy'] }).notNull().default('idle'),
    busySince: ts('busy_since'),
    source: text('source', { enum: ['native', 'openai', 'anthropic'] }).notNull().default('native'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    archivedAt: ts('archived_at'),
  },
  (t) => [index('conversations_user_idx').on(t.userId, t.updatedAt)],
);

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; fileId: string; mimeType: string }
  | { type: 'document'; fileId: string; filename: string; mimeType: string };

export interface ArtifactRef {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'video' | 'audio' | 'file';
}

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    content: jsonb('content').$type<ContentBlock[]>().notNull(),
    artifacts: jsonb('artifacts').$type<ArtifactRef[]>().notNull().default([]),
    model: text('model'),
    credits: doublePrecision('credits'),
    stopReason: text('stop_reason'),
    error: jsonb('error').$type<{ code: string; message: string } | null>(),
    createdAt: createdAt(),
  },
  (t) => [index('messages_conversation_idx').on(t.conversationId, t.createdAt)],
);

/** Stateless (OpenAI/Anthropic) history fingerprint → conversation. */
export const compatThreads = pgTable('compat_threads', {
  key: text('key').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  createdAt: createdAt(),
});

// ── files & media ───────────────────────────────────────────────────────────

export const files = pgTable(
  'files',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['upload', 'artifact'] }).notNull(),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    storagePath: text('storage_path').notNull(),
    qoderFileId: text('qoder_file_id'),
    conversationId: text('conversation_id'),
    jobId: text('job_id'),
    /** What a vision model saw in this image (outfit, palette, background…), cached for prompt variations. */
    traits: jsonb('traits').$type<Record<string, string>>(),
    createdAt: createdAt(),
    /** Set while the file's job is in the trash: hidden from users (404), still served to admins via trash URLs. */
    deletedAt: ts('deleted_at'),
  },
  (t) => [index('files_user_idx').on(t.userId, t.createdAt)],
);

export const mediaJobs = pgTable(
  'media_jobs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['image', 'video'] }).notNull(),
    status: text('status', { enum: ['queued', 'in_progress', 'completed', 'failed'] }).notNull().default('queued'),
    request: jsonb('request').$type<Record<string, unknown>>().notNull(),
    qoderSessionId: text('qoder_session_id'),
    lastEventId: text('last_event_id'),
    progress: integer('progress').notNull().default(0),
    resultFileIds: jsonb('result_file_ids').$type<string[]>().notNull().default([]),
    error: jsonb('error').$type<{ code: string; message: string } | null>(),
    callbackUrl: text('callback_url'),
    /** Jobs created together by one `POST /images` with `n` share a batch id (null for single jobs). */
    batchId: text('batch_id'),
    /** In the trash since (hidden from the gallery); purged for good after the grace period. */
    deletedAt: ts('deleted_at'),
    /** Who trashed it: the owner, an admin, or housekeeping (old failed jobs, retention). */
    deletedBy: text('deleted_by', { enum: ['user', 'admin', 'system'] }),
    credits: doublePrecision('credits'),
    createdAt: createdAt(),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
  },
  (t) => [index('media_jobs_status_idx').on(t.status, t.createdAt), index('media_jobs_batch_idx').on(t.batchId), index('media_jobs_deleted_idx').on(t.deletedAt)],
);

// ── webhooks & usage ────────────────────────────────────────────────────────

export const webhooks = pgTable('webhooks', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  secret: text('secret').notNull(),
  events: jsonb('events').$type<string[]>().notNull(),
  createdAt: createdAt(),
  disabledAt: ts('disabled_at'),
});

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    webhookId: text('webhook_id'),
    url: text('url').notNull(),
    secret: text('secret'),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status', { enum: ['pending', 'delivered', 'failed'] }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [index('webhook_deliveries_due_idx').on(t.status, t.nextAttemptAt)],
);

export const usageEvents = pgTable(
  'usage_events',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    conversationId: text('conversation_id'),
    jobId: text('job_id'),
    kind: text('kind', { enum: ['chat', 'image', 'video'] }).notNull(),
    model: text('model'),
    creditsModel: doublePrecision('credits_model').notNull().default(0),
    creditsSandbox: doublePrecision('credits_sandbox').notNull().default(0),
    creditsTotal: doublePrecision('credits_total').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('usage_user_idx').on(t.userId, t.createdAt)],
);
