import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  type AuthenticatorTransportFuture,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { and, asc, count, eq, gt, lt } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { passkeys, webauthnChallenges } from '../db/schema.js';
import { AppError, badRequest, conflict, notFound, unauthorized } from '../errors.js';
import type { Logger } from '../log.js';
import { newId } from '../ids.js';
import type { AuthService, TokenPair, UserRow } from './auth.js';

export type PasskeyRow = typeof passkeys.$inferSelect;

const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_PASSKEYS_PER_USER = 20;
const NAME_MAX = 60;

/**
 * Well-known authenticator models (AAGUID → provider), used to name a new passkey ("iCloud Keychain") so users can tell
 * them apart in Settings. Unknown ones fall back to "Passkey". Source: the community passkey-authenticator-aaguids list.
 */
const AAGUID_NAMES: Record<string, string> = {
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud Keychain',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud Keychain',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  '531126d6-e717-415c-9320-3d9aa6981239': 'Dashlane',
  'b84e4048-15dc-4dd0-8640-f4f60813c8af': 'NordPass',
  '0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6': 'Keeper',
  '53414d53-554e-4700-0000-000000000000': 'Samsung Pass',
};

export const passkeyProvider = (aaguid: string | null) => (aaguid ? AAGUID_NAMES[aaguid] : undefined) ?? null;

/** Public JSON of a passkey (never the key itself). */
export const passkeyView = (p: PasskeyRow) => ({
  id: p.id,
  name: p.name,
  provider: passkeyProvider(p.aaguid),
  /** true for synced passkeys (iCloud Keychain, Google Password Manager…), false for a single device / security key. */
  synced: p.deviceType === 'multiDevice',
  backed_up: p.backedUp,
  created_at: p.createdAt.toISOString(),
  last_used_at: p.lastUsedAt?.toISOString() ?? null,
});

export interface PasskeyConfig {
  /** null = passkeys disabled (no https origin to derive it from). */
  rpId: string | null;
  rpName: string;
  /** Web origins plus `android:apk-key-hash:…` origins of the Android app. */
  origins: string[];
  android: { package: string; certSha256: string[] } | null;
  iosAppIds: string[];
}

/** The origin Android's Credential Manager reports for an app signed with this certificate. */
export const androidOrigin = (sha256Fingerprint: string) => `android:apk-key-hash:${Buffer.from(sha256Fingerprint.replace(/:/g, ''), 'hex').toString('base64url')}`;

/** RP ID + allowed origins from config: PASSKEY_* or derived from CORS_ORIGINS; native app ids for the .well-known files. */
export function passkeyConfig(c: {
  PASSKEY_RP_ID?: string;
  PASSKEY_RP_NAME: string;
  PASSKEY_ORIGINS?: string[];
  CORS_ORIGINS: string[];
  PASSKEY_ANDROID_PACKAGE?: string;
  PASSKEY_ANDROID_CERT_SHA256?: string[];
  PASSKEY_IOS_APP_IDS?: string[];
}): PasskeyConfig {
  const web = (c.PASSKEY_ORIGINS ?? c.CORS_ORIGINS).filter((o) => o !== '*').map((o) => o.replace(/\/+$/, ''));
  const firstHttps = web.find((o) => o.startsWith('https://'));
  const rpId = c.PASSKEY_RP_ID ?? (firstHttps ? new URL(firstHttps).hostname : null);
  const certs = c.PASSKEY_ANDROID_CERT_SHA256 ?? [];
  const android = c.PASSKEY_ANDROID_PACKAGE && certs.length ? { package: c.PASSKEY_ANDROID_PACKAGE, certSha256: certs } : null;
  return { rpId, rpName: c.PASSKEY_RP_NAME, origins: [...web, ...(android ? certs.map(androidOrigin) : [])], android, iosAppIds: c.PASSKEY_IOS_APP_IDS ?? [] };
}

/**
 * Digital Asset Links for the RP domain (`https://<rpId>/.well-known/assetlinks.json`): lets the Android app use the
 * site's passkeys. null when no Android app is configured.
 */
export function assetLinks(cfg: PasskeyConfig) {
  if (!cfg.android) return null;
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
      target: { namespace: 'android_app', package_name: cfg.android.package, sha256_cert_fingerprints: cfg.android.certSha256 },
    },
  ];
}

/** `https://<rpId>/.well-known/apple-app-site-association`: lets the iOS app use the site's passkeys. */
export function appleAppSiteAssociation(cfg: PasskeyConfig) {
  return cfg.iosAppIds.length ? { webcredentials: { apps: cfg.iosAppIds } } : null;
}

/**
 * Passkey (WebAuthn) registration and sign-in. Challenges live in the DB (one-time, 5 min) so a restart or a second
 * instance does not break a ceremony in progress. Sign-in is "usernameless": the browser offers the passkeys it has for
 * this site and the credential tells us who the user is.
 */
export class PasskeyService {
  constructor(
    private readonly d: {
      db: DB;
      auth: AuthService;
      log: Logger;
      config: PasskeyConfig;
    },
  ) {}

  get enabled(): boolean {
    return !!this.d.config.rpId;
  }

  get config(): PasskeyConfig {
    return this.d.config;
  }

  // ── registration (signed in) ────────────────────────────────────────────

  async registrationOptions(user: UserRow, origin: string | undefined) {
    const rpId = this.rpIdFor(origin);
    const existing = await this.list(user.id);
    if (existing.length >= MAX_PASSKEYS_PER_USER) throw conflict(`At most ${MAX_PASSKEYS_PER_USER} passkeys per account`, 'too_many_passkeys');
    const options = await generateRegistrationOptions({
      rpName: this.d.config.rpName,
      rpID: rpId,
      userName: user.email,
      userDisplayName: user.displayName ?? user.email,
      // stable per user, no personal data: the browser uses it to replace an old passkey of the same account
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      // the authenticator refuses to create a second passkey for this account on the same provider
      excludeCredentials: existing.filter((p) => p.rpId === rpId).map((p) => ({ id: p.id, transports: p.transports as AuthenticatorTransportFuture[] })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const challengeId = await this.saveChallenge('register', options.challenge, rpId, user.id);
    return { challenge_id: challengeId, options };
  }

  async verifyRegistration(user: UserRow, challengeId: string, response: RegistrationResponseJSON, name?: string): Promise<PasskeyRow> {
    const ch = await this.takeChallenge(challengeId, 'register');
    if (ch.userId !== user.id) throw badRequest('This challenge belongs to another session', 'invalid_challenge');
    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: this.d.config.origins,
        expectedRPID: ch.rpId,
        requireUserVerification: true,
      });
    } catch (err) {
      this.d.log.warn('passkey.register_failed', { userId: user.id, err: (err as Error).message });
      throw badRequest(`Passkey could not be verified: ${(err as Error).message}`, 'passkey_invalid');
    }
    if (!verification.verified) throw badRequest('Passkey could not be verified', 'passkey_invalid');
    const info = verification.registrationInfo;
    const [taken] = await this.d.db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.id, info.credential.id));
    if (taken) throw conflict('This passkey is already registered', 'passkey_exists');
    const [row] = await this.d.db
      .insert(passkeys)
      .values({
        id: info.credential.id,
        userId: user.id,
        publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
        counter: info.credential.counter,
        transports: info.credential.transports ?? [],
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        aaguid: info.aaguid,
        name: cleanName(name) ?? passkeyProvider(info.aaguid) ?? 'Passkey',
        rpId: ch.rpId,
      })
      .returning();
    this.d.log.info('passkey.registered', { userId: user.id, provider: passkeyProvider(info.aaguid), synced: info.credentialDeviceType === 'multiDevice' });
    return row!;
  }

  // ── sign-in (public) ────────────────────────────────────────────────────

  async loginOptions(origin: string | undefined) {
    const rpId = this.rpIdFor(origin);
    // no allowCredentials: the browser shows every passkey it has for this site (no email needed)
    const options = await generateAuthenticationOptions({ rpID: rpId, userVerification: 'required' });
    const challengeId = await this.saveChallenge('login', options.challenge, rpId, null);
    return { challenge_id: challengeId, options };
  }

  async verifyLogin(challengeId: string, response: AuthenticationResponseJSON): Promise<{ user: UserRow; tokens: TokenPair; passkey: PasskeyRow }> {
    const ch = await this.takeChallenge(challengeId, 'login');
    const [pk] = await this.d.db.select().from(passkeys).where(eq(passkeys.id, response.id));
    // the browser may still hold a passkey whose account or registration was deleted here
    if (!pk) throw new AppError(401, 'passkey_not_found', 'This passkey is not registered (it may have been removed). Sign in another way.');
    const handle = response.response.userHandle;
    if (handle && Buffer.from(handle, 'base64url').toString('utf8') !== pk.userId) throw unauthorized('Passkey does not match its account');
    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: this.d.config.origins,
        expectedRPID: ch.rpId,
        credential: { id: pk.id, publicKey: Buffer.from(pk.publicKey, 'base64url'), counter: pk.counter, transports: pk.transports as AuthenticatorTransportFuture[] },
        requireUserVerification: true,
      });
    } catch (err) {
      this.d.log.warn('passkey.login_failed', { passkeyId: pk.id, err: (err as Error).message });
      throw unauthorized('Passkey sign-in failed');
    }
    if (!verification.verified) throw unauthorized('Passkey sign-in failed');
    const user = await this.d.auth.getUser(pk.userId);
    if (user.disabledAt) throw unauthorized('Account disabled');
    const [updated] = await this.d.db
      .update(passkeys)
      .set({ counter: verification.authenticationInfo.newCounter, backedUp: verification.authenticationInfo.credentialBackedUp, lastUsedAt: new Date() })
      .where(eq(passkeys.id, pk.id))
      .returning();
    return { user, tokens: await this.d.auth.issueTokens(user.id), passkey: updated! };
  }

  // ── management (signed in) ──────────────────────────────────────────────

  list(userId: string): Promise<PasskeyRow[]> {
    return this.d.db.select().from(passkeys).where(eq(passkeys.userId, userId)).orderBy(asc(passkeys.createdAt));
  }

  async countFor(userId: string): Promise<number> {
    const [r] = await this.d.db.select({ n: count() }).from(passkeys).where(eq(passkeys.userId, userId));
    return Number(r?.n ?? 0);
  }

  async rename(userId: string, id: string, name: string): Promise<PasskeyRow> {
    const clean = cleanName(name);
    if (!clean) throw badRequest('name is required', 'validation_error');
    const [row] = await this.d.db.update(passkeys).set({ name: clean }).where(and(eq(passkeys.id, id), eq(passkeys.userId, userId))).returning();
    if (!row) throw notFound('Passkey');
    return row;
  }

  /** Refuses to remove the last way to sign in (no password and no other passkey). */
  async remove(user: UserRow, id: string): Promise<void> {
    const [row] = await this.d.db.select().from(passkeys).where(and(eq(passkeys.id, id), eq(passkeys.userId, user.id)));
    if (!row) throw notFound('Passkey');
    if (!user.passwordHash && (await this.countFor(user.id)) <= 1) {
      throw conflict('This is your only way to sign in. Set a password or add another passkey first.', 'last_sign_in_method');
    }
    await this.d.db.delete(passkeys).where(eq(passkeys.id, id));
    this.d.log.info('passkey.removed', { userId: user.id });
  }

  /** Admin: remove a user's passkey (e.g. a lost phone) without the last-method guard; the admin can set a password. */
  async adminRemove(userId: string, id: string): Promise<void> {
    const rows = await this.d.db.delete(passkeys).where(and(eq(passkeys.id, id), eq(passkeys.userId, userId))).returning({ id: passkeys.id });
    if (!rows.length) throw notFound('Passkey');
    this.d.log.info('passkey.removed_by_admin', { userId });
  }

  // ── internals ───────────────────────────────────────────────────────────

  /**
   * The RP ID for a request's Origin: `localhost` for local dev, otherwise the configured domain. Native apps send no
   * Origin header and get the configured domain (their real origin is checked in the signed response).
   */
  private rpIdFor(origin: string | undefined): string {
    const rpId = this.d.config.rpId;
    if (!rpId) throw new AppError(503, 'passkeys_not_configured', 'Passkeys are not configured on this server');
    if (!origin || origin === 'null') return rpId;
    const o = origin.replace(/\/+$/, '');
    if (!this.d.config.origins.includes(o)) throw new AppError(403, 'origin_not_allowed', `Passkeys are not enabled for ${o}`);
    const host = new URL(o).hostname;
    if (host === 'localhost') return 'localhost';
    if (host === rpId || host.endsWith(`.${rpId}`)) return rpId;
    throw new AppError(403, 'origin_not_allowed', `${o} is not part of ${rpId}`);
  }

  private async saveChallenge(kind: 'register' | 'login', challenge: string, rpId: string, userId: string | null): Promise<string> {
    // housekeeping: drop expired challenges (cheap, indexed by primary key scan on a tiny table)
    await this.d.db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, new Date()));
    const id = newId('wch');
    await this.d.db.insert(webauthnChallenges).values({ id, challenge, kind, userId, rpId, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) });
    return id;
  }

  /** One-time: the challenge is deleted as it is read, so a response cannot be replayed. */
  private async takeChallenge(id: string, kind: 'register' | 'login') {
    const [row] = await this.d.db
      .delete(webauthnChallenges)
      .where(and(eq(webauthnChallenges.id, id), eq(webauthnChallenges.kind, kind), gt(webauthnChallenges.expiresAt, new Date())))
      .returning();
    if (!row) throw badRequest('The passkey request expired or was already used; start again', 'invalid_challenge');
    return row;
  }
}

function cleanName(name: string | undefined | null): string | null {
  const n = name?.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  return n || null;
}

/** Whether a user can still sign in after an auth change (used by /me). */
export const signInMethods = (user: UserRow, passkeyCount: number) => ({ password: !!user.passwordHash, passkeys: passkeyCount });
