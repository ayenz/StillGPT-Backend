import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { androidOrigin } from '../../src/auth/passkeys.js';
import { loadConfig } from '../../src/config.js';
import { type Harness, startHarness } from './harness.js';
import { VirtualAuthenticator } from './virtualAuthenticator.js';

const APP = 'https://app.example.com';
const RELEASE = Array(32).fill('AB').join(':');
const DEBUG = Array(32).fill('0F').join(':');
const ANDROID = androidOrigin(RELEASE);

let h: Harness;
beforeAll(async () => {
  h = await startHarness({
    env: {
      CORS_ORIGINS: APP,
      PASSKEY_ANDROID_PACKAGE: 'id.ayenz.stillgpt',
      PASSKEY_ANDROID_CERT_SHA256: `${RELEASE}, ${DEBUG.toLowerCase()}`,
      PASSKEY_IOS_APP_IDS: 'ABCDE12345.id.ayenz.stillgpt',
    },
  });
});
afterAll(() => h?.close());

const json = async (res: Response) => ({ status: res.status, body: (await res.json().catch(() => null)) as any });

/** A native app's request: no Origin header. */
const native = (path: string, payload?: unknown, token?: string) =>
  fetch(`${h.url}/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

describe('native app passkeys', () => {
  it('androidOrigin is the base64url of the certificate hash', () => {
    expect(androidOrigin(RELEASE)).toBe(`android:apk-key-hash:${Buffer.alloc(32, 0xab).toString('base64url')}`);
  });

  it('serves assetlinks.json and apple-app-site-association from config', async () => {
    const links = await json(await fetch(`${h.url}/.well-known/assetlinks.json`));
    expect(links.body).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
        target: { namespace: 'android_app', package_name: 'id.ayenz.stillgpt', sha256_cert_fingerprints: [RELEASE, DEBUG] },
      },
    ]);
    const aasa = await fetch(`${h.url}/.well-known/apple-app-site-association`);
    expect(aasa.headers.get('content-type')).toMatch(/application\/json/);
    expect(await aasa.json()).toEqual({ webcredentials: { apps: ['ABCDE12345.id.ayenz.stillgpt'] } });
  });

  it('Android app: register and sign in without an Origin header, with the apk-key-hash origin', async () => {
    const user = await h.ctx.auth.createUser({ email: 'android@test.local', password: 'password-123' });
    const { access_token } = await h.ctx.auth.issueTokens(user.id);
    const auth = new VirtualAuthenticator('ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4');

    const reg = await json(await native('/me/passkeys/options', undefined, access_token));
    expect(reg.body.options.rp.id).toBe('app.example.com');
    const added = await json(await native('/me/passkeys', { challenge_id: reg.body.challenge_id, response: auth.create(reg.body.options, ANDROID) }, access_token));
    expect(added).toMatchObject({ status: 201, body: { provider: 'Google Password Manager' } });

    const opts = await json(await native('/auth/passkey/options'));
    expect(opts.body.options.rpId).toBe('app.example.com');
    const login = await json(await native('/auth/passkey/verify', { challenge_id: opts.body.challenge_id, response: auth.get(opts.body.options, ANDROID) }));
    expect(login).toMatchObject({ status: 200, body: { user: { id: user.id } } });

    // the same passkey is usable from the website (shared via Google Password Manager)
    const web = await json(await fetch(`${h.url}/api/v1/auth/passkey/options`, { method: 'POST', headers: { origin: APP } }));
    const fromWeb = await json(
      await fetch(`${h.url}/api/v1/auth/passkey/verify`, {
        method: 'POST',
        headers: { origin: APP, 'content-type': 'application/json' },
        body: JSON.stringify({ challenge_id: web.body.challenge_id, response: auth.get(web.body.options, APP) }),
      }),
    );
    expect(fromWeb.status).toBe(200);
  });

  it('an app signed with an unknown certificate is rejected', async () => {
    const user = await h.ctx.auth.createUser({ email: 'repack@test.local', password: 'password-123' });
    const { access_token } = await h.ctx.auth.issueTokens(user.id);
    const reg = await json(await native('/me/passkeys/options', undefined, access_token));
    const evil = androidOrigin(Array(32).fill('11').join(':'));
    const r = await json(await native('/me/passkeys', { challenge_id: reg.body.challenge_id, response: new VirtualAuthenticator().create(reg.body.options, evil) }, access_token));
    expect(r.body.error.code).toBe('passkey_invalid');
  });

  it('config validation', () => {
    const base = { JWT_SECRET: 'x'.repeat(32) };
    expect(() => loadConfig({ ...base, PASSKEY_ANDROID_PACKAGE: 'id.ayenz.stillgpt' })).toThrow(/both PASSKEY_ANDROID_PACKAGE/);
    expect(() => loadConfig({ ...base, PASSKEY_ANDROID_PACKAGE: 'id.ayenz.stillgpt', PASSKEY_ANDROID_CERT_SHA256: 'AB:CD' })).toThrow(/32 hex bytes/);
    expect(() => loadConfig({ ...base, PASSKEY_IOS_APP_IDS: 'id.ayenz.stillgpt' })).toThrow(/TEAMID/);
  });
});
