import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { Env } from '../../http.js';
import { body } from './util.js';

const KEY = z
  .string()
  .min(16)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+=*$/, 'must be base64url');
const ENDPOINT = z.string().url().max(2048);
const FCM_TOKEN = z.string().min(1).max(4096);

/** /me/push*, /me/fcm-tokens*: Web Push subscriptions (PWA) and FCM tokens (Android app) for "creation ready" notifications. */
export function pushRoutes(ctx: AppContext) {
  const app = new Hono<Env>();

  /** Whether the server sends pushes, and the VAPID key for `pushManager.subscribe({ applicationServerKey })`. */
  app.get('/me/push', (c) => c.json({ enabled: ctx.push.enabled, public_key: ctx.push.publicKey, fcm: ctx.fcm.enabled }));

  /** This browser's `PushSubscription.toJSON()`; the same endpoint again updates it (or moves it to this user). */
  app.post('/me/push-subscriptions', async (c) => {
    const b = await body(c, z.object({ endpoint: ENDPOINT, keys: z.object({ p256dh: KEY, auth: KEY }) }));
    const row = await ctx.push.subscribe(c.get('user').id, b, c.req.header('user-agent'));
    return c.json({ id: row.id, created_at: row.createdAt.toISOString() }, 201);
  });

  app.delete('/me/push-subscriptions', async (c) => {
    const b = await body(c, z.object({ endpoint: ENDPOINT }));
    await ctx.push.unsubscribe(c.get('user').id, b.endpoint);
    return c.body(null, 204);
  });

  /** Sends a test notification to this browser. */
  app.post('/me/push-subscriptions/test', async (c) => {
    const b = await body(c, z.object({ endpoint: ENDPOINT }));
    await ctx.push.test(c.get('user').id, b.endpoint);
    return c.body(null, 204);
  });

  /** The Android app's FCM registration token; the same token again updates it (or moves it to this user). */
  app.post('/me/fcm-tokens', async (c) => {
    const b = await body(
      c,
      z.object({ token: FCM_TOKEN, platform: z.literal('android'), device: z.string().trim().max(100).optional() }),
    );
    await ctx.fcm.register(c.get('user').id, b.token, b.platform, b.device || null);
    return c.body(null, 204);
  });

  app.delete('/me/fcm-tokens', async (c) => {
    const b = await body(c, z.object({ token: FCM_TOKEN }));
    await ctx.fcm.unregister(c.get('user').id, b.token);
    return c.body(null, 204);
  });

  /** Sends a test notification to all of the user's Android app installs. */
  app.post('/me/fcm-tokens/test', async (c) => {
    const r = await ctx.fcm.test(c.get('user').id);
    return c.json(r, 202);
  });

  return app;
}
