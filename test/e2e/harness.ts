import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { type AppContext, createContext } from '../../src/context.js';
import type { PushSender } from '../../src/core/push.js';
import type { FilmAssembler } from '../../src/core/runs/assembler.js';
import { silentLogger } from '../../src/log.js';
import { type MockQoder, type MockQoderOptions, startMockQoder } from '../mock-qoder/index.js';

export interface Harness {
  /** StillGPT base URL, e.g. http://127.0.0.1:PORT */
  url: string;
  ctx: AppContext;
  qoder: MockQoder;
  /** A regular user's API key (sg_…) and id. */
  apiKey: string;
  userId: string;
  /** Admin credentials (also usable with /api/v1/auth/login). */
  admin: { email: string; password: string; apiKey: string };
  /** fetch against StillGPT with the user's API key preset. */
  api(path: string, init?: RequestInit & { json?: unknown; key?: string }): Promise<Response>;
  close(): Promise<void>;
}

/**
 * Boots mock Qoder + StillGPT (in-memory PGlite, temp media dir) on random ports.
 * Everything is real except the upstream.
 */
export async function startHarness(
  opts: { mock?: MockQoderOptions; env?: Record<string, string>; pushSender?: PushSender; fcmFetch?: typeof fetch; filmAssembler?: FilmAssembler } = {},
): Promise<Harness> {
  const qoder = await startMockQoder({ heartbeatMs: 1000, ...opts.mock });
  const mediaDir = await mkdtemp(join(tmpdir(), 'qr-media-'));
  const admin = { email: 'admin@test.local', password: 'admin-password-123' };

  // PUBLIC_BASE_URL needs the port, which we only know after listening → start with placeholder, patch after.
  const config = loadConfig({
    DATABASE_URL: 'pglite://memory',
    QODER_BASE_URL: qoder.url,
    QODER_PAT: 'pt-test',
    JWT_SECRET: 'test-secret-test-secret-test-secret-123',
    MEDIA_DIR: mediaDir,
    ADMIN_EMAIL: admin.email,
    ADMIN_PASSWORD: admin.password,
    MODEL_SYNC_INTERVAL_MIN: '0',
    LOG_LEVEL: 'error',
    ...opts.env,
  });
  const ctx = await createContext(config, { log: silentLogger, qoderRetryBaseMs: 5, pushSender: opts.pushSender, fcmFetch: opts.fcmFetch, filmAssembler: opts.filmAssembler });
  const app = createApp(ctx);
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((r) => server.once('listening', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (ctx.config as { PUBLIC_BASE_URL: string }).PUBLIC_BASE_URL = url;
  (ctx.store as unknown as { publicBaseUrl: string }).publicBaseUrl = url;
  await ctx.start();

  const adminUser = (await ctx.auth.listUsers()).find((u) => u.role === 'admin')!;
  const adminKey = (await ctx.auth.createApiKey(adminUser.id, 'test-admin')).key;
  const user = await ctx.auth.createUser({ email: 'user@test.local', password: 'user-password-123' });
  const apiKey = (await ctx.auth.createApiKey(user.id, 'test')).key;

  const api: Harness['api'] = (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has('authorization')) headers.set('authorization', `Bearer ${init.key ?? apiKey}`);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(init.json);
    }
    return fetch(url + path, { ...init, headers, body });
  };

  return {
    url,
    ctx,
    qoder,
    apiKey,
    userId: user.id,
    admin: { ...admin, apiKey: adminKey },
    api,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await ctx.close();
      await qoder.close();
      await rm(mediaDir, { recursive: true, force: true });
    },
  };
}

/** Collect all TurnEvents of a turn handle. */
export async function drain<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of it) out.push(e);
  return out;
}
