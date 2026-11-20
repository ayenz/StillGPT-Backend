import { and, eq } from 'drizzle-orm';
import webpush from 'web-push';
import type { DB } from '../db/client.js';
import { pushSubscriptions } from '../db/schema.js';
import { AppError, badRequest, notFound } from '../errors.js';
import { newId } from '../ids.js';
import type { Logger } from '../log.js';

export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;

/** What the service worker gets (JSON): it shows `title`/`body`/`image` and opens `url` (a frontend path) on tap. */
export interface PushMessage {
  title: string;
  body: string;
  /** Frontend path, e.g. `/gallery/<jobId>`. */
  url: string;
  /** Same tag = the newer notification replaces the older one (e.g. one per image batch). */
  tag: string;
  /** Large picture (Android/desktop Chrome); a signed media URL. */
  image?: string;
}

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Sends one encrypted push; rejects with `{ statusCode }` on an HTTP error from the push service. */
export type PushSender = (target: PushTarget, payload: string, o: { ttlSec: number; urgency: 'normal' | 'high' }) => Promise<unknown>;

export interface PushConfig {
  publicKey: string;
  privateKey: string;
  /** VAPID contact: `mailto:` or `https:` URL. */
  subject: string;
}

/**
 * Push services of the browsers we support. Subscriptions are only accepted (and pushes only sent) to these hosts,
 * so a client cannot make the backend POST to arbitrary URLs.
 */
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];

export function isPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** How long a push waits for an offline device. */
const TTL_SEC = 24 * 3600;

/**
 * Web Push (VAPID) to the user's browsers. Disabled (enabled = false) without VAPID keys: subscribe answers 503,
 * notify does nothing. Subscriptions the push service reports gone (404/410) are deleted.
 */
export class PushService {
  readonly enabled: boolean;
  private readonly send: PushSender;

  constructor(
    private readonly d: { db: DB; log: Logger; config: PushConfig | null; sender?: PushSender },
  ) {
    this.enabled = !!d.config;
    const c = d.config;
    this.send =
      d.sender ??
      ((target, payload, o) =>
        webpush.sendNotification(target, payload, {
          TTL: o.ttlSec,
          urgency: o.urgency,
          timeout: 15_000,
          vapidDetails: { subject: c!.subject, publicKey: c!.publicKey, privateKey: c!.privateKey },
        }));
  }

  get publicKey(): string | null {
    return this.d.config?.publicKey ?? null;
  }

  /** Stores (or moves to this user) the browser's subscription; the same endpoint is one row. */
  async subscribe(userId: string, sub: PushTarget, userAgent?: string | null): Promise<PushSubscriptionRow> {
    this.requireEnabled();
    if (!isPushEndpoint(sub.endpoint)) throw badRequest('endpoint is not a supported push service');
    const values = { userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent: userAgent?.slice(0, 300) ?? null };
    const [row] = await this.d.db
      .insert(pushSubscriptions)
      .values({ id: newId('push'), endpoint: sub.endpoint, ...values })
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values })
      .returning();
    return row!;
  }

  /** Removes this browser's subscription of the user (no-op when it is not there). */
  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    await this.d.db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
  }

  /** Sends a test notification to one of the user's subscriptions. */
  async test(userId: string, endpoint: string): Promise<void> {
    this.requireEnabled();
    const [row] = await this.d.db
      .select()
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
    if (!row) throw notFound('Push subscription');
    const ok = await this.deliver(row, { title: 'Notifications are on', body: 'You will get one like this when a creation finishes.', url: '/gallery', tag: 'test' });
    if (!ok) throw badRequest('The push service rejected this browser’s subscription; turn notifications off and on again');
  }

  /** Sends to every subscription of the user; never throws. */
  async notify(userId: string, msg: PushMessage): Promise<void> {
    if (!this.enabled) return;
    try {
      const rows = await this.d.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
      await Promise.all(rows.map((row) => this.deliver(row, msg)));
    } catch (err) {
      this.d.log.error('push.notify_failed', { userId, err });
    }
  }

  /** true = accepted by the push service. Gone subscriptions are deleted. */
  private async deliver(row: PushSubscriptionRow, msg: PushMessage): Promise<boolean> {
    if (!isPushEndpoint(row.endpoint)) {
      await this.d.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, row.id));
      return false;
    }
    try {
      await this.send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, JSON.stringify(msg), { ttlSec: TTL_SEC, urgency: 'normal' });
      await this.d.db.update(pushSubscriptions).set({ lastSuccessAt: new Date() }).where(eq(pushSubscriptions.id, row.id));
      return true;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await this.d.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, row.id));
        this.d.log.info('push.subscription_gone', { id: row.id, status });
      } else {
        this.d.log.warn('push.send_failed', { id: row.id, status: status ?? null, err: (err as Error).message });
      }
      return false;
    }
  }

  private requireEnabled() {
    if (!this.enabled) throw new AppError(503, 'push_unavailable', 'Push notifications are not configured on the server');
  }
}
