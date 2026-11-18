import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppContext } from './context.js';
import { AppError, anthropicErrorBody, nativeErrorBody, openaiErrorBody, toAppError } from './errors.js';
import type { Env } from './http.js';
import { appleAppSiteAssociation, assetLinks } from './auth/passkeys.js';
import { newId } from './ids.js';
import { anthropicRoutes } from './routes/anthropic/index.js';
import { mediaRoutes } from './routes/media.js';
import { nativeRoutes } from './routes/native/index.js';
import { openaiRoutes } from './routes/openai/index.js';

/**
 * URL layout:
 *   /api/v1/*        native API (PWA, Flutter, n8n)
 *   /v1/messages*    Anthropic-compatible
 *   /v1/*            OpenAI-compatible
 *   /media/:id       signed downloads
 *   /healthz         liveness
 */
export function createApp(ctx: AppContext) {
  const app = new Hono<Env>();

  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? newId('req');
    c.set('requestId', requestId);
    c.header('X-Request-Id', requestId);
    const started = Date.now();
    await next();
    ctx.log.debug('http', { method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - started, requestId });
  });
  app.use(
    '*',
    cors({
      origin: ctx.config.CORS_ORIGINS.includes('*') ? '*' : ctx.config.CORS_ORIGINS,
      allowHeaders: ['Authorization', 'Content-Type', 'x-api-key', 'anthropic-version', 'anthropic-beta', 'X-StillGPT-Conversation', 'X-StillGPT-Profile', 'Last-Event-ID'],
      exposeHeaders: ['X-Request-Id', 'X-StillGPT-Conversation', 'X-StillGPT-Model', 'X-StillGPT-Credits'],
      maxAge: 86400,
    }),
  );

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', async (c) => {
    const models = ctx.models.listActive().length;
    return c.json({ ok: models > 0, models }, models > 0 ? 200 : 503);
  });

  // Passkey association files for native apps. They must be served from the RP domain (the frontend); these copies are the
  // source to deploy there and to check against (see docs/handoff/flutter-passkeys.md).
  app.get('/.well-known/assetlinks.json', (c) => {
    const body = assetLinks(ctx.passkeys.config);
    return body ? c.json(body) : c.json(nativeErrorBody(new AppError(404, 'not_configured', 'No Android app is configured')), 404);
  });
  app.get('/.well-known/apple-app-site-association', (c) => {
    const body = appleAppSiteAssociation(ctx.passkeys.config);
    return body ? c.json(body) : c.json(nativeErrorBody(new AppError(404, 'not_configured', 'No iOS app is configured')), 404);
  });

  app.route('/', mediaRoutes(ctx));
  app.route('/api/v1', nativeRoutes(ctx));
  app.route('/v1', anthropicRoutes(ctx));
  app.route('/v1', openaiRoutes(ctx));

  app.notFound((c) => c.json(nativeErrorBody(new AppError(404, 'not_found', 'Route not found')), 404));

  // One error handler, three envelopes — chosen by URL so each SDK sees errors it understands.
  app.onError((err, c) => {
    const e = toAppError(err);
    if (e.status >= 500) ctx.log.error('http.error', { path: c.req.path, code: e.code, err, requestId: c.get('requestId') });
    const path = c.req.path;
    const body = path.startsWith('/v1/messages') ? anthropicErrorBody(e) : path.startsWith('/v1/') ? openaiErrorBody(e) : nativeErrorBody(e);
    return c.json(body, e.status as 400);
  });

  return app;
}
