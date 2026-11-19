import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TurnstileVerifier, turnstileConfig } from '../../src/auth/turnstile.js';
import { silentLogger } from '../../src/log.js';
import { type Harness, startHarness } from './harness.js';

/** Fake siteverify: token "good" passes (once), "wrong-action"/"wrong-host" pass with bad claims, "down" is a 500. */
function fakeSiteverify(calls: URLSearchParams[]): typeof fetch {
  const used = new Set<string>();
  return (async (_url: string, init?: RequestInit) => {
    const form = new URLSearchParams(init!.body as URLSearchParams);
    calls.push(form);
    const token = form.get('response')!;
    if (token === 'down') return new Response('oops', { status: 500 });
    const reply = (body: object) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (used.has(token)) return reply({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    used.add(token);
    if (token === 'good') return reply({ success: true, action: 'login', hostname: 'app.example.com' });
    if (token === 'wrong-action') return reply({ success: true, action: 'signup', hostname: 'app.example.com' });
    if (token === 'wrong-host') return reply({ success: true, action: 'login', hostname: 'evil.example.net' });
    return reply({ success: false, 'error-codes': ['invalid-input-response'] });
  }) as typeof fetch;
}

describe('turnstileConfig', () => {
  it('is off without a secret and derives hostnames from CORS_ORIGINS', () => {
    expect(turnstileConfig({ CORS_ORIGINS: ['https://a.example.com'] })).toBeNull();
    expect(turnstileConfig({ TURNSTILE_SECRET_KEY: 's', CORS_ORIGINS: ['*', 'https://A.example.com/', 'http://localhost:5173'] })?.hostnames).toEqual([
      'a.example.com',
      'localhost',
    ]);
    expect(turnstileConfig({ TURNSTILE_SECRET_KEY: 's', TURNSTILE_HOSTNAMES: ['app.example.com'], CORS_ORIGINS: ['https://a.example.com'] })?.hostnames).toEqual([
      'app.example.com',
    ]);
  });
});

describe('POST /auth/login with Turnstile', () => {
  let h: Harness;
  const calls: URLSearchParams[] = [];
  const login = (extra: Record<string, unknown>, headers: Record<string, string> = {}) =>
    fetch(`${h.url}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ email: 'user@test.local', password: 'user-password-123', ...extra }),
    });

  beforeAll(async () => {
    h = await startHarness({ env: { TURNSTILE_SECRET_KEY: 'test-secret', TURNSTILE_HOSTNAMES: 'app.example.com' } });
    expect(h.ctx.turnstile).not.toBeNull();
    h.ctx.turnstile = new TurnstileVerifier({ secret: 'test-secret', hostnames: ['app.example.com'] }, silentLogger, fakeSiteverify(calls));
  });
  afterAll(() => h?.close());

  it('signs in with a valid token, sends secret + client IP, and rejects replaying it', async () => {
    const ok = await login({ turnstile_token: 'good' }, { 'cf-connecting-ip': '203.0.113.7' });
    expect(ok.status).toBe(200);
    expect((await ok.json()).access_token).toEqual(expect.any(String));
    const sent = calls.at(-1)!;
    expect(sent.get('secret')).toBe('test-secret');
    expect(sent.get('remoteip')).toBe('203.0.113.7');

    const replay = await login({ turnstile_token: 'good' });
    expect(replay.status).toBe(403);
    expect((await replay.json()).error.code).toBe('turnstile_failed');
  });

  it.each([['missing', undefined], ['invalid', 'bogus'], ['wrong action', 'wrong-action'], ['wrong hostname', 'wrong-host'], ['siteverify down', 'down']])(
    'fails closed: %s',
    async (_name, token) => {
      const res = await login(token === undefined ? {} : { turnstile_token: token });
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe('turnstile_failed');
    },
  );

  it('checks the token before the password', async () => {
    const res = await login({ password: 'wrong-password', turnstile_token: 'bogus-2' });
    expect(res.status).toBe(403);
  });

  it('leaves passkey sign-in and refresh alone', async () => {
    const res = await fetch(`${h.url}/api/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: 'rt_nope' }) });
    expect(res.status).toBe(401);
  });
});
