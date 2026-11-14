import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { SignJWT, jwtVerify } from 'jose';
import type { DB } from '../db/client.js';
import { apiKeys, refreshTokens, users } from '../db/schema.js';
import { AppError, badRequest, conflict, notFound, unauthorized } from '../errors.js';
import { newId, randomId, safeEqual, sha256 } from '../ids.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export type UserRow = typeof users.$inferSelect;
export type PublicUser = Pick<UserRow, 'id' | 'email' | 'displayName' | 'role' | 'monthlyCreditLimit' | 'createdAt'>;

const ACCESS_TTL_SEC = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;
const API_KEY_PREFIX = 'sg_';
/** Keys issued before the StillGPT rename; still accepted. */
const LEGACY_API_KEY_PREFIXES = ['qr_'];

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [algo, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const hash = await scrypt(password, Buffer.from(saltB64, 'base64'), 64);
  return safeEqual(hash.toString('base64'), hashB64);
}

export const publicUser = (u: UserRow): PublicUser => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  role: u.role,
  monthlyCreditLimit: u.monthlyCreditLimit,
  createdAt: u.createdAt,
});

export interface TokenPair {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
}

/** Users, sessions (JWT + rotating refresh tokens) and API keys. */
export class AuthService {
  private readonly key: Uint8Array;

  constructor(
    private readonly db: DB,
    jwtSecret: string,
  ) {
    this.key = new TextEncoder().encode(jwtSecret);
  }

  // ── users ───────────────────────────────────────────────────────────────
  async createUser(input: { email: string; password?: string; displayName?: string; role?: 'admin' | 'user'; monthlyCreditLimit?: number | null }) {
    const email = input.email.trim().toLowerCase();
    const [exists] = await this.db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (exists) throw conflict('A user with this email already exists', 'email_taken');
    const [row] = await this.db
      .insert(users)
      .values({
        id: newId('usr'),
        email,
        passwordHash: input.password ? await hashPassword(input.password) : null,
        displayName: input.displayName ?? null,
        role: input.role ?? 'user',
        monthlyCreditLimit: input.monthlyCreditLimit ?? null,
      })
      .returning();
    return row!;
  }

  /** Create the first admin from env if no admin exists yet. */
  async ensureAdmin(email?: string, password?: string) {
    if (!email || !password) return;
    const [admin] = await this.db.select({ id: users.id }).from(users).where(eq(users.role, 'admin')).limit(1);
    if (!admin) await this.createUser({ email, password, role: 'admin', displayName: 'Admin' });
  }

  async getUser(id: string): Promise<UserRow> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id));
    if (!row) throw notFound('User');
    return row;
  }

  listUsers = () => this.db.select().from(users).orderBy(users.createdAt);

  async updateUser(id: string, patch: { displayName?: string | null; password?: string; role?: 'admin' | 'user'; monthlyCreditLimit?: number | null; disabled?: boolean }) {
    await this.getUser(id);
    const [row] = await this.db
      .update(users)
      .set({
        ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
        ...(patch.password ? { passwordHash: await hashPassword(patch.password) } : {}),
        ...(patch.role ? { role: patch.role } : {}),
        ...(patch.monthlyCreditLimit !== undefined ? { monthlyCreditLimit: patch.monthlyCreditLimit } : {}),
        ...(patch.disabled !== undefined ? { disabledAt: patch.disabled ? new Date() : null } : {}),
      })
      .where(eq(users.id, id))
      .returning();
    return row!;
  }

  // ── sessions ────────────────────────────────────────────────────────────
  async login(email: string, password: string): Promise<{ user: UserRow; tokens: TokenPair }> {
    const [user] = await this.db.select().from(users).where(eq(users.email, email.trim().toLowerCase()));
    if (!user || user.disabledAt || !(await verifyPassword(password, user.passwordHash))) throw unauthorized('Invalid email or password');
    return { user, tokens: await this.issueTokens(user.id) };
  }

  /** Rotating refresh: the presented token is revoked and a new pair is issued. */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const [row] = await this.db
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.tokenHash, sha256(refreshToken)), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, new Date())));
    if (!row) throw unauthorized('Invalid or expired refresh token');
    await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, row.id));
    const user = await this.getUser(row.userId);
    if (user.disabledAt) throw unauthorized('Account disabled');
    return this.issueTokens(user.id);
  }

  async logout(refreshToken: string) {
    await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.tokenHash, sha256(refreshToken)));
  }

  private async issueTokens(userId: string): Promise<TokenPair> {
    const access = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt().setExpirationTime(`${ACCESS_TTL_SEC}s`).sign(this.key);
    const refresh = `rt_${randomId(40)}`;
    await this.db.insert(refreshTokens).values({ id: newId('rt'), userId, tokenHash: sha256(refresh), expiresAt: new Date(Date.now() + REFRESH_TTL_MS) });
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_SEC, refresh_token: refresh };
  }

  // ── API keys ────────────────────────────────────────────────────────────
  async createApiKey(userId: string, name: string) {
    if (!name.trim()) throw badRequest('name is required');
    const key = `${API_KEY_PREFIX}${randomId(40)}`;
    const [row] = await this.db
      .insert(apiKeys)
      .values({ id: newId('key'), userId, name: name.trim(), prefix: key.slice(0, 10), keyHash: sha256(key) })
      .returning();
    return { ...row!, key };
  }

  listApiKeys = (userId: string) =>
    this.db
      .select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, createdAt: apiKeys.createdAt, lastUsedAt: apiKeys.lastUsedAt })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)));

  async revokeApiKey(userId: string, id: string) {
    const rows = await this.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    if (!rows.length) throw notFound('API key');
  }

  /** Accepts an API key (`sg_…`) or an access JWT. */
  async authenticate(credential: string): Promise<UserRow> {
    let userId: string | undefined;
    if ([API_KEY_PREFIX, ...LEGACY_API_KEY_PREFIXES].some((p) => credential.startsWith(p))) {
      const [row] = await this.db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.keyHash, sha256(credential)), isNull(apiKeys.revokedAt)));
      if (!row) throw unauthorized('Invalid API key');
      userId = row.userId;
      void this.db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id)).catch(() => {});
    } else {
      try {
        const { payload } = await jwtVerify(credential, this.key, { algorithms: ['HS256'] });
        userId = payload.sub;
      } catch {
        throw unauthorized('Invalid or expired access token');
      }
    }
    if (!userId) throw unauthorized();
    const user = await this.getUser(userId).catch(() => {
      throw unauthorized();
    });
    if (user.disabledAt) throw new AppError(403, 'account_disabled', 'Account disabled');
    return user;
  }
}
