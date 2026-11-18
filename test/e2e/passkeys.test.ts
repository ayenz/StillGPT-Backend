import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { passkeyConfig } from '../../src/auth/passkeys.js';
import { type Harness, startHarness } from './harness.js';
import { VirtualAuthenticator } from './virtualAuthenticator.js';

const APP = 'https://app.example.com';
const DEV = 'http://localhost:5173';

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ env: { CORS_ORIGINS: `${APP},${DEV}` } });
});
afterAll(() => h?.close());

const json = async (res: Response) => ({ status: res.status, body: (await res.json().catch(() => null)) as any });

/** A fresh user with an access token (password optional). */
async function newUser(password: string | null = 'password-123') {
  const email = `pk-${Math.random().toString(36).slice(2)}@test.local`;
  const user = await h.ctx.auth.createUser({ email, password: password ?? undefined });
  const tokens = await h.ctx.auth.issueTokens(user.id);
  const call = (path: string, init: RequestInit & { json?: unknown; origin?: string; auth?: boolean } = {}) => {
    const headers = new Headers(init.headers);
    if (init.auth !== false) headers.set('authorization', `Bearer ${tokens.access_token}`);
    headers.set('origin', init.origin ?? APP);
    if (init.json !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${h.url}/api/v1${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  };
  return { user, email, call };
}

async function register(u: Awaited<ReturnType<typeof newUser>>, auth: VirtualAuthenticator, o: { origin?: string; name?: string } = {}) {
  const opts = await json(await u.call('/me/passkeys/options', { method: 'POST', origin: o.origin }));
  expect(opts.status).toBe(200);
  const response = auth.create(opts.body.options, o.origin ?? APP);
  return json(await u.call('/me/passkeys', { method: 'POST', origin: o.origin, json: { challenge_id: opts.body.challenge_id, response, name: o.name } }));
}

const anon = (path: string, payload?: unknown, origin = APP) =>
  fetch(`${h.url}/api/v1${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) });

async function signIn(auth: VirtualAuthenticator, origin = APP, tweak: (opts: any) => Record<string, unknown> = () => ({})) {
  const opts = await json(await anon('/auth/passkey/options', undefined, origin));
  const response = auth.get(opts.body.options, origin, tweak(opts.body.options));
  return { opts, res: await json(await anon('/auth/passkey/verify', { challenge_id: opts.body.challenge_id, response }, origin)) };
}

describe('passkeyConfig', () => {
  it('derives the RP ID from the first https origin, disabled without one', () => {
    expect(passkeyConfig({ PASSKEY_RP_NAME: 'X', CORS_ORIGINS: ['http://localhost:5173', 'https://stillgpt.ayenz.my.id/'] })).toEqual({
      rpId: 'stillgpt.ayenz.my.id',
      rpName: 'X',
      origins: ['http://localhost:5173', 'https://stillgpt.ayenz.my.id'],
    });
    expect(passkeyConfig({ PASSKEY_RP_NAME: 'X', CORS_ORIGINS: ['*'] }).rpId).toBeNull();
    expect(passkeyConfig({ PASSKEY_RP_ID: 'ayenz.my.id', PASSKEY_RP_NAME: 'X', CORS_ORIGINS: ['https://a.ayenz.my.id'] }).rpId).toBe('ayenz.my.id');
  });
});

describe('registering a passkey', () => {
  it('creates a discoverable, user-verified passkey named after its provider', async () => {
    const u = await newUser();
    const me0 = await json(await u.call('/me'));
    expect(me0.body.sign_in).toEqual({ password: true, passkeys: 0, passkeys_available: true });

    const opts = await json(await u.call('/me/passkeys/options', { method: 'POST' }));
    expect(opts.body.options).toMatchObject({
      rp: { id: 'app.example.com', name: 'StillGPT' },
      user: { name: u.email },
      attestation: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: [],
    });
    expect(opts.body.challenge_id).toMatch(/^wch_/);

    const auth = new VirtualAuthenticator();
    const r = await json(await u.call('/me/passkeys', { method: 'POST', json: { challenge_id: opts.body.challenge_id, response: auth.create(opts.body.options, APP) } }));
    expect(r.status).toBe(201);
    expect(r.body).toEqual({
      id: expect.any(String),
      name: 'iCloud Keychain',
      provider: 'iCloud Keychain',
      synced: true,
      backed_up: true,
      created_at: expect.any(String),
      last_used_at: null,
    });
    expect((await json(await u.call('/me'))).body.sign_in.passkeys).toBe(1);
    // the same authenticator is told not to make a second one
    const again = await json(await u.call('/me/passkeys/options', { method: 'POST' }));
    expect(again.body.options.excludeCredentials).toEqual([{ id: r.body.id, type: 'public-key', transports: ['internal', 'hybrid'] }]);
  });

  it('a custom name is kept; challenges are single-use and per user', async () => {
    const u = await newUser();
    const auth = new VirtualAuthenticator('00000000-0000-0000-0000-000000000000');
    const opts = await json(await u.call('/me/passkeys/options', { method: 'POST' }));
    const response = auth.create(opts.body.options, APP);
    const ok = await json(await u.call('/me/passkeys', { method: 'POST', json: { challenge_id: opts.body.challenge_id, response, name: '  Laptop   kantor ' } }));
    expect(ok.body).toMatchObject({ name: 'Laptop kantor', provider: null });
    const replay = await json(await u.call('/me/passkeys', { method: 'POST', json: { challenge_id: opts.body.challenge_id, response } }));
    expect(replay.body.error.code).toBe('invalid_challenge');

    const other = await newUser();
    const o2 = await json(await u.call('/me/passkeys/options', { method: 'POST' }));
    const stolen = await json(await other.call('/me/passkeys', { method: 'POST', json: { challenge_id: o2.body.challenge_id, response: auth.create(o2.body.options, APP) } }));
    expect(stolen.body.error.code).toBe('invalid_challenge');
  });

  it('rejects a response without user verification or from another origin', async () => {
    const u = await newUser();
    const auth = new VirtualAuthenticator();
    let opts = await json(await u.call('/me/passkeys/options', { method: 'POST' }));
    let r = await json(await u.call('/me/passkeys', { method: 'POST', json: { challenge_id: opts.body.challenge_id, response: auth.create(opts.body.options, APP, { userVerified: false }) } }));
    expect(r).toMatchObject({ status: 400, body: { error: { code: 'passkey_invalid' } } });

    opts = await json(await u.call('/me/passkeys/options', { method: 'POST' }));
    r = await json(await u.call('/me/passkeys', { method: 'POST', json: { challenge_id: opts.body.challenge_id, response: auth.create(opts.body.options, 'https://evil.example.net') } }));
    expect(r.body.error.code).toBe('passkey_invalid');

    expect((await json(await u.call('/me/passkeys/options', { method: 'POST', origin: 'https://evil.example.net' }))).body.error.code).toBe('origin_not_allowed');
    expect((await u.call('/me/passkeys/options', { method: 'POST', auth: false })).status).toBe(401);
  });

  it('uses rpId localhost for the dev origin', async () => {
    const u = await newUser();
    const r = await register(u, new VirtualAuthenticator(), { origin: DEV });
    expect(r.status).toBe(201);
    const opts = await json(await anon('/auth/passkey/options', undefined, DEV));
    expect(opts.body.options.rpId).toBe('localhost');
  });
});

describe('signing in with a passkey', () => {
  it('needs no email: options → fingerprint → tokens, like /auth/login', async () => {
    const u = await newUser();
    const auth = new VirtualAuthenticator();
    await register(u, auth);

    const { opts, res } = await signIn(auth);
    expect(opts.body.options).toMatchObject({ rpId: 'app.example.com', userVerification: 'required' });
    expect(opts.body.options.allowCredentials ?? []).toEqual([]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ user: { id: u.user.id, email: u.email }, token_type: 'Bearer', access_token: expect.any(String), refresh_token: expect.any(String) });

    const me = await fetch(`${h.url}/api/v1/me`, { headers: { authorization: `Bearer ${res.body.access_token}` } });
    expect(((await me.json()) as any).user.id).toBe(u.user.id);
    const list = await json(await u.call('/me/passkeys'));
    expect(list.body.data[0].last_used_at).not.toBeNull();
    // the refresh token works like a password session's
    expect((await anon('/auth/refresh', { refresh_token: res.body.refresh_token })).status).toBe(200);
  });

  it('cannot replay a sign-in', async () => {
    const u = await newUser();
    const auth = new VirtualAuthenticator();
    await register(u, auth);
    const opts = await json(await anon('/auth/passkey/options'));
    const response = auth.get(opts.body.options, APP);
    expect((await anon('/auth/passkey/verify', { challenge_id: opts.body.challenge_id, response })).status).toBe(200);
    const replay = await json(await anon('/auth/passkey/verify', { challenge_id: opts.body.challenge_id, response }));
    expect(replay.body.error.code).toBe('invalid_challenge');
  });

  it('rejects unknown, tampered, unverified and foreign-origin answers', async () => {
    const u = await newUser();
    const auth = new VirtualAuthenticator();
    await register(u, auth);

    const stranger = new VirtualAuthenticator();
    const strangerOpts = await json(await u.call('/me/passkeys/options', { method: 'POST' }));
    stranger.create(strangerOpts.body.options, APP); // created on the device but never sent to us
    expect((await signIn(stranger)).res.body.error.code).toBe('passkey_not_found');

    expect((await signIn(auth, APP, () => ({ userVerified: false }))).res.status).toBe(401);
    expect((await signIn(auth, APP, () => ({ userHandle: Buffer.from('usr_someone_else') }))).res.status).toBe(401);

    const opts = await json(await anon('/auth/passkey/options'));
    const forged = auth.get(opts.body.options, 'https://evil.example.net');
    expect((await anon('/auth/passkey/verify', { challenge_id: opts.body.challenge_id, response: forged })).status).toBe(401);

    expect((await json(await anon('/auth/passkey/verify', { challenge_id: 'x' }))).status).toBe(400);
  });

  it('a disabled account cannot sign in', async () => {
    const u = await newUser();
    const auth = new VirtualAuthenticator();
    await register(u, auth);
    await h.ctx.auth.updateUser(u.user.id, { disabled: true });
    expect((await signIn(auth)).res.status).toBe(401);
  });
});

describe('managing passkeys', () => {
  it('rename and delete', async () => {
    const u = await newUser();
    const pk = (await register(u, new VirtualAuthenticator())).body;
    const renamed = await json(await u.call(`/me/passkeys/${pk.id}`, { method: 'PATCH', json: { name: 'iPhone 17' } }));
    expect(renamed.body.name).toBe('iPhone 17');
    expect((await u.call(`/me/passkeys/${pk.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await json(await u.call('/me/passkeys'))).body.data).toEqual([]);
    expect((await u.call(`/me/passkeys/${pk.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('a removed passkey can no longer sign in', async () => {
    const u = await newUser();
    const auth = new VirtualAuthenticator();
    const pk = (await register(u, auth)).body;
    await u.call(`/me/passkeys/${pk.id}`, { method: 'DELETE' });
    expect((await signIn(auth)).res.body.error.code).toBe('passkey_not_found');
  });

  it('will not remove the only way to sign in', async () => {
    const u = await newUser(null); // no password
    const a = (await register(u, new VirtualAuthenticator())).body;
    expect((await json(await u.call(`/me/passkeys/${a.id}`, { method: 'DELETE' }))).body.error.code).toBe('last_sign_in_method');
    const b = (await register(u, new VirtualAuthenticator('00000000-0000-0000-0000-000000000001'))).body;
    expect((await u.call(`/me/passkeys/${a.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await json(await u.call(`/me/passkeys/${b.id}`, { method: 'DELETE' }))).status).toBe(409);
    expect((await json(await u.call('/me'))).body.sign_in).toMatchObject({ password: false, passkeys: 1 });
  });

  it("other users' passkeys are invisible", async () => {
    const u = await newUser();
    const pk = (await register(u, new VirtualAuthenticator())).body;
    const other = await newUser();
    expect((await other.call(`/me/passkeys/${pk.id}`, { method: 'PATCH', json: { name: 'x' } })).status).toBe(404);
    expect((await other.call(`/me/passkeys/${pk.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('admins can list and remove a user’s passkeys (lost device)', async () => {
    const u = await newUser(null);
    const auth = new VirtualAuthenticator();
    const pk = (await register(u, auth)).body;
    const admin = (path: string, init: RequestInit = {}) => h.api(path, { ...init, key: h.admin.apiKey });
    const list = await json(await admin(`/api/v1/admin/users/${u.user.id}/passkeys`));
    expect(list.body.data.map((p: any) => p.id)).toEqual([pk.id]);
    expect((await admin(`/api/v1/admin/users/${u.user.id}/passkeys/${pk.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await signIn(auth)).res.body.error.code).toBe('passkey_not_found');
    expect((await h.api(`/api/v1/admin/users/${u.user.id}/passkeys`)).status).toBe(403);
  });
});
