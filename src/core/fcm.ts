import { createSign } from 'node:crypto';
import { isIP } from 'node:net';
import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { fcmTokens } from '../db/schema.js';
import { AppError, notFound } from '../errors.js';
import { newId } from '../ids.js';
import type { Logger } from '../log.js';

export type FcmTokenRow = typeof fcmTokens.$inferSelect;

/** The fields of a Firebase service-account JSON that FCM needs. */
export interface FcmServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

/** Decodes FCM_SERVICE_ACCOUNT_B64; throws on a malformed value (fail at startup, not on the first job). */
export function parseServiceAccount(b64: string): FcmServiceAccount {
  let sa: Partial<FcmServiceAccount>;
  try {
    sa = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    throw new Error('FCM_SERVICE_ACCOUNT_B64 is not base64 of a JSON service account');
  }
  for (const k of ['project_id', 'client_email', 'private_key'] as const)
    if (typeof sa[k] !== 'string' || !sa[k]) throw new Error(`FCM_SERVICE_ACCOUNT_B64: ${k} is missing`);
  return sa as FcmServiceAccount;
}

/** What the Android app gets: a system notification plus `data` for routing the tap. */
export interface FcmMessage {
  title: string;
  body: string;
  /** Same tag = the newer notification replaces the older one (job or batch id). */
  tag: string;
  /** Large picture; only sent when FCM can fetch it (public https URL). */
  image?: string;
  /** String values only: `{type: "job"|"batch"|"test", job_id?, batch_id?, path?}`. */
  data: Record<string, string>;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
/** How long a message waits for an offline device (same as Web Push). */
const TTL = '86400s';
const TIMEOUT_MS = 15_000;

/** https on a public host name (not localhost / a private or literal IP): something Google's servers can download. */
export function isPublicHttpsUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.')) return false;
  return !/(^|\.)(localhost|local|internal|lan|home)$/.test(host);
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

/**
 * Firebase Cloud Messaging (HTTP v1) to the native Android app. Disabled (enabled = false) without a service account:
 * tokens are still stored, notify does nothing, test answers 503. Tokens FCM reports unregistered/invalid are deleted.
 */
export class FcmService {
  readonly enabled: boolean;
  private readonly fetch: typeof fetch;
  private access: { token: string; exp: number } | null = null;
  private pendingAccess: Promise<string> | null = null;

  constructor(private readonly d: { db: DB; log: Logger; account: FcmServiceAccount | null; fetchImpl?: typeof fetch }) {
    this.enabled = !!d.account;
    this.fetch = d.fetchImpl ?? fetch;
  }

  /** Stores the app's token for this user (a token known for another user moves to this one). */
  async register(userId: string, token: string, platform: 'android', device?: string | null): Promise<void> {
    const values = { userId, platform, device: device ?? null, lastUsedAt: new Date() };
    await this.d.db
      .insert(fcmTokens)
      .values({ id: newId('fcm'), token, ...values })
      .onConflictDoUpdate({ target: fcmTokens.token, set: values });
  }

  /** Removes the user's token (no-op when it is not theirs or not there). */
  async unregister(userId: string, token: string): Promise<void> {
    await this.d.db.delete(fcmTokens).where(and(eq(fcmTokens.userId, userId), eq(fcmTokens.token, token)));
  }

  /** Sends a test notification to every token of the user; resolves to how many FCM accepted. */
  async test(userId: string): Promise<{ sent: number; failed: number }> {
    if (!this.enabled) throw new AppError(503, 'push_unavailable', 'FCM push notifications are not configured on the server');
    const rows = await this.d.db.select().from(fcmTokens).where(eq(fcmTokens.userId, userId));
    if (!rows.length) throw notFound('FCM token');
    const msg: FcmMessage = { title: 'StillGPT notifications are on', body: 'You will get one like this when a creation finishes.', tag: 'test', data: { type: 'test' } };
    const ok = await Promise.all(rows.map((row) => this.deliver(row, msg)));
    const sent = ok.filter(Boolean).length;
    return { sent, failed: ok.length - sent };
  }

  /** Sends to every token of the user; never throws. */
  async notify(userId: string, msg: FcmMessage): Promise<void> {
    if (!this.enabled) return;
    try {
      const rows = await this.d.db.select().from(fcmTokens).where(eq(fcmTokens.userId, userId));
      await Promise.all(rows.map((row) => this.deliver(row, msg)));
    } catch (err) {
      this.d.log.error('fcm.notify_failed', { userId, err });
    }
  }

  /** true = accepted by FCM. Unregistered/invalid tokens are deleted; other errors are logged. */
  private async deliver(row: FcmTokenRow, msg: FcmMessage): Promise<boolean> {
    const account = this.d.account!;
    const image = msg.image && isPublicHttpsUrl(msg.image) ? msg.image : undefined;
    const message = {
      token: row.token,
      notification: { title: msg.title, body: msg.body, ...(image ? { image } : {}) },
      android: { priority: 'high', ttl: TTL, notification: { channel_id: 'creations', icon: 'ic_stat_stillgpt', tag: msg.tag } },
      data: msg.data,
    };
    try {
      const res = await this.fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        await this.d.db.update(fcmTokens).set({ lastUsedAt: new Date() }).where(eq(fcmTokens.id, row.id));
        return true;
      }
      const err = ((await res.json().catch(() => null)) as { error?: FcmError } | null)?.error;
      if (res.status === 401) this.access = null; // expired/revoked access token: fetch a new one next time
      if (isDeadToken(res.status, err)) {
        await this.d.db.delete(fcmTokens).where(eq(fcmTokens.id, row.id));
        this.d.log.info('fcm.token_gone', { id: row.id, status: res.status, code: fcmErrorCode(err) });
      } else {
        this.d.log.warn('fcm.send_failed', { id: row.id, status: res.status, code: fcmErrorCode(err), err: err?.message ?? null });
      }
      return false;
    } catch (err) {
      this.d.log.warn('fcm.send_failed', { id: row.id, status: null, err: (err as Error).message });
      return false;
    }
  }

  /** OAuth access token from a self-signed service-account JWT (RS256), cached until shortly before it expires. */
  private async accessToken(): Promise<string> {
    if (this.access && this.access.exp > Date.now() + 60_000) return this.access.token;
    this.pendingAccess ??= this.fetchAccessToken().finally(() => (this.pendingAccess = null));
    return this.pendingAccess;
  }

  private async fetchAccessToken(): Promise<string> {
    const a = this.d.account!;
    const iat = Math.floor(Date.now() / 1000);
    const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: a.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }))}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(a.private_key).toString('base64url');
    const res = await this.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number; error?: string } | null;
    if (!res.ok || !body?.access_token) throw new Error(`FCM OAuth token request failed: ${res.status} ${body?.error ?? ''}`.trim());
    this.access = { token: body.access_token, exp: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }
}

interface FcmError {
  code?: number;
  message?: string;
  status?: string;
  details?: { '@type'?: string; errorCode?: string }[];
}

const fcmErrorCode = (err: FcmError | undefined) =>
  err?.details?.find((x) => x['@type']?.endsWith('google.firebase.fcm.v1.FcmError'))?.errorCode ?? err?.status ?? null;

/** UNREGISTERED, NOT_FOUND, or INVALID_ARGUMENT about the token itself (not about the payload). */
function isDeadToken(status: number, err: FcmError | undefined): boolean {
  const code = fcmErrorCode(err);
  if (code === 'UNREGISTERED' || code === 'NOT_FOUND' || status === 404) return true;
  return code === 'INVALID_ARGUMENT' && /registration token/i.test(err?.message ?? '');
}
