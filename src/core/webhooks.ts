import { createHmac } from 'node:crypto';
import { and, asc, eq, inArray, isNull, lte } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { users, webhookDeliveries, webhooks } from '../db/schema.js';
import { badRequest, notFound } from '../errors.js';
import { newId, randomId } from '../ids.js';
import type { Logger } from '../log.js';

export type WebhookRow = typeof webhooks.$inferSelect;
export type DeliveryRow = typeof webhookDeliveries.$inferSelect;

export const WEBHOOK_EVENTS = [
  'image.completed',
  'image.failed',
  'video.completed',
  'video.failed',
  'model.added',
  'model.retired',
  'model.updated',
  'provider.degraded',
  'run.completed',
  'run.failed',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

/** Sent by `POST /webhooks/:id/test`; not subscribable. */
export const WEBHOOK_TEST_EVENT = 'webhook.test';

export interface WebhookPayload {
  id: string;
  type: string;
  created_at: string;
  data: Record<string, unknown>;
}

export interface WebhookServiceOptions {
  /** How often the worker looks for due deliveries. Default 5 s. */
  pollIntervalMs?: number;
  /** Delay before retry n (after the first failed attempt). Default 1 m, 5 m, 30 m. */
  retryDelaysMs?: number[];
  /** Per-attempt HTTP timeout. Default 10 s. */
  timeoutMs?: number;
}

export interface AttemptOutcome {
  delivered: boolean;
  status: number | null;
  error: string | null;
}

const DEFAULT_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000];
const BATCH_SIZE = 25;

/** HMAC-SHA256 of the raw body, hex — the value of `X-StillGPT-Signature` after `sha256=`. */
export const signWebhook = (secret: string, rawBody: string) => createHmac('sha256', secret).update(rawBody).digest('hex');

/**
 * Outgoing webhooks. Every delivery is a row in `webhook_deliveries`, so retries survive restarts:
 * `emit`/`deliverTo` enqueue, the worker POSTs due rows and reschedules failures (1 m / 5 m / 30 m, then `failed`).
 */
export class WebhookService {
  private readonly pollIntervalMs: number;
  private readonly retryDelaysMs: number[];
  private readonly timeoutMs: number;
  private readonly inflight = new Set<string>();
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly db: DB,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
    opts: WebhookServiceOptions = {},
  ) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 5000;
    this.retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  // ── endpoints ───────────────────────────────────────────────────────────

  async create(userId: string, input: { url: string; events: WebhookEventType[] }): Promise<WebhookRow & { secret: string }> {
    assertHttpUrl(input.url);
    const events = [...new Set(input.events)];
    if (!events.length) throw badRequest('events must list at least one event type', 'validation_error');
    const unknown = events.filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
    if (unknown.length) throw badRequest(`Unknown webhook event(s): ${unknown.join(', ')}`, 'validation_error');
    const [row] = await this.db
      .insert(webhooks)
      .values({ id: newId('wh'), userId, url: input.url, secret: `whsec_${randomId(32)}`, events })
      .returning();
    return row!;
  }

  list(userId: string): Promise<WebhookRow[]> {
    return this.db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.userId, userId), isNull(webhooks.disabledAt)))
      .orderBy(asc(webhooks.createdAt));
  }

  async remove(userId: string, id: string): Promise<void> {
    const rows = await this.db
      .update(webhooks)
      .set({ disabledAt: new Date() })
      .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId), isNull(webhooks.disabledAt)))
      .returning({ id: webhooks.id });
    if (!rows.length) throw notFound('Webhook');
  }

  /** Deliver a `webhook.test` event to one endpoint right now and report the outcome (no retries). */
  async sendTest(userId: string, id: string): Promise<AttemptOutcome & { delivery_id: string }> {
    const [hook] = await this.db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId), isNull(webhooks.disabledAt)));
    if (!hook) throw notFound('Webhook');
    const [row] = await this.enqueue([{ webhookId: hook.id, url: hook.url, secret: hook.secret }], WEBHOOK_TEST_EVENT, { message: 'Hello from StillGPT' }, { maxAttempts: 1 });
    const outcome = await this.attempt(row!, 1);
    return { ...outcome, delivery_id: row!.id };
  }

  // ── events ──────────────────────────────────────────────────────────────

  /** Fan out to the user's subscribed endpoints (userId null = all admins' endpoints, used for model.* and provider.* events). */
  async emit(userId: string | null, type: WebhookEventType, data: Record<string, unknown>): Promise<void> {
    const owners = userId ? [userId] : (await this.db.select({ id: users.id }).from(users).where(eq(users.role, 'admin'))).map((u) => u.id);
    if (!owners.length) return;
    const hooks = (await this.db.select().from(webhooks).where(and(inArray(webhooks.userId, owners), isNull(webhooks.disabledAt)))).filter((h) =>
      h.events.includes(type),
    );
    if (!hooks.length) return;
    await this.enqueue(
      hooks.map((h) => ({ webhookId: h.id, url: h.url, secret: h.secret })),
      type,
      data,
    );
    this.kick();
  }

  /** One-off delivery to a per-request callback_url (n8n Wait node resume URL). Unsigned. */
  async deliverTo(url: string, type: WebhookEventType, data: Record<string, unknown>): Promise<void> {
    await this.enqueue([{ webhookId: null, url, secret: null }], type, data);
    this.kick();
  }

  // ── worker ──────────────────────────────────────────────────────────────

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.kick(), this.pollIntervalMs);
    this.timer.unref();
    this.kick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Process due deliveries now (also called right after enqueueing so callbacks are near-instant). */
  private kick() {
    if (this.running) return;
    this.running = true;
    void this.processDue()
      .catch((err) => this.log.error('webhooks.worker_failed', { err }))
      .finally(() => (this.running = false));
  }

  private async processDue() {
    for (;;) {
      const due = await this.db
        .select()
        .from(webhookDeliveries)
        .where(and(eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextAttemptAt, new Date())))
        .orderBy(asc(webhookDeliveries.nextAttemptAt))
        .limit(BATCH_SIZE);
      const fresh = due.filter((d) => !this.inflight.has(d.id));
      if (!fresh.length) return;
      await Promise.all(fresh.map((d) => this.attempt(d, this.retryDelaysMs.length + 1)));
      if (due.length < BATCH_SIZE) return;
    }
  }

  private async enqueue(
    targets: { webhookId: string | null; url: string; secret: string | null }[],
    type: string,
    data: Record<string, unknown>,
    o: { maxAttempts?: number } = {},
  ): Promise<DeliveryRow[]> {
    const payload: WebhookPayload = { id: newId('evt'), type, created_at: new Date().toISOString(), data };
    return this.db
      .insert(webhookDeliveries)
      .values(
        targets.map((t) => ({
          id: newId('whd'),
          webhookId: t.webhookId,
          url: t.url,
          secret: t.secret,
          eventType: type,
          payload: payload as unknown as Record<string, unknown>,
          // a test delivery is attempted inline; keep the worker away from it
          ...(o.maxAttempts === 1 ? { nextAttemptAt: new Date(Date.now() + 3600_000) } : {}),
        })),
      )
      .returning();
  }

  /** POST one delivery and record the result; schedules the next retry or gives up after `maxAttempts`. */
  private async attempt(d: DeliveryRow, maxAttempts: number): Promise<AttemptOutcome> {
    this.inflight.add(d.id);
    try {
      const outcome = await this.post(d);
      const attempts = d.attempts + 1;
      if (outcome.delivered) {
        await this.db.update(webhookDeliveries).set({ status: 'delivered', attempts, lastError: null }).where(eq(webhookDeliveries.id, d.id));
      } else {
        const delay = this.retryDelaysMs[attempts - 1];
        const giveUp = attempts >= maxAttempts || delay === undefined;
        await this.db
          .update(webhookDeliveries)
          .set({
            attempts,
            lastError: outcome.error,
            status: giveUp ? 'failed' : 'pending',
            ...(giveUp ? {} : { nextAttemptAt: new Date(Date.now() + delay) }),
          })
          .where(eq(webhookDeliveries.id, d.id));
        this.log.warn('webhooks.delivery_failed', { deliveryId: d.id, url: d.url, attempts, giveUp, error: outcome.error });
      }
      return outcome;
    } finally {
      this.inflight.delete(d.id);
    }
  }

  private async post(d: DeliveryRow): Promise<AttemptOutcome> {
    const body = JSON.stringify(d.payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'StillGPT-Webhooks/1',
      'X-StillGPT-Event': d.eventType,
      'X-StillGPT-Delivery': d.id,
    };
    if (d.secret) headers['X-StillGPT-Signature'] = `sha256=${signWebhook(d.secret, body)}`;
    try {
      const res = await this.fetchImpl(d.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'manual' });
      await res.body?.cancel().catch(() => {});
      return res.ok ? { delivered: true, status: res.status, error: null } : { delivered: false, status: res.status, error: `HTTP ${res.status}` };
    } catch (err) {
      return { delivered: false, status: null, error: (err as Error).message };
    }
  }
}

function assertHttpUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest('url must be an absolute http(s) URL', 'validation_error');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw badRequest('url must be an absolute http(s) URL', 'validation_error');
}

export { assertHttpUrl as assertWebhookUrl };
