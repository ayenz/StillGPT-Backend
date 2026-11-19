import { Hono } from 'hono';
import type { AppContext } from '../../context.js';
import type { Env } from '../../http.js';

/**
 * Folax status for the UI: whether the optional Folax features (chat models, image-to-video, edit, remove people) can
 * run now, and the shared weekly quota. Folax is a nice-to-have provider: when it is down its features fail, nothing
 * falls back to Qoder.
 */
async function folaxStatus(ctx: AppContext, opts: { fresh?: boolean; admin?: boolean } = {}) {
  if (!ctx.folax) return { configured: false, available: false, status: 'down' as const, checked_at: null, error: { code: 'not_configured', message: 'Folax is not configured' }, usage: null };
  const [upstream, usage] = await Promise.all([ctx.folax.upstream(opts.fresh), ctx.folax.usage(opts.fresh)]);
  return {
    configured: true,
    available: upstream.status !== 'down',
    status: upstream.status,
    checked_at: upstream.checked_at,
    error: upstream.error,
    usage,
    ...(opts.admin ? { latency_ms: upstream.latency_ms, token: upstream.token } : {}),
  };
}

/** GET /folax/status (any signed-in user; cached ~60 s). */
export function folaxRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  app.get('/folax/status', async (c) => c.json(await folaxStatus(ctx)));
  return app;
}

/** GET /admin/folax/status: checks Folax now (`fresh`) and adds the token details. Mounted under /admin (requireAdmin). */
export function folaxAdminRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  app.get('/admin/folax/status', async (c) => c.json(await folaxStatus(ctx, { fresh: true, admin: true })));
  return app;
}
