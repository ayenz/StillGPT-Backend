import { Hono } from 'hono';
import type { AppContext } from '../../context.js';
import { type Env, requireAdmin, requireUser } from '../../http.js';
import { adminRoutes, authRoutes, meRoutes } from './account.js';
import { conversationRoutes } from './conversations.js';
import { faceRoutes } from './faces.js';
import { galleryAdminRoutes, galleryRoutes } from './gallery.js';
import { fileRoutes, mediaJobRoutes, promptRoutes, webhookRoutes } from './media.js';

/**
 * Native API, mounted at /api/v1 (PWA, Flutter, n8n). snake_case JSON, errors `{error:{code,message}}`.
 * Reference: docs/API.md.
 */
export function nativeRoutes(ctx: AppContext) {
  const app = new Hono<Env>();

  // Unauthenticated routes must be registered before the auth middleware.
  app.route('/', authRoutes(ctx));
  app.use('*', requireUser(ctx));
  app.use('/admin/*', requireAdmin());

  app.route('/', meRoutes(ctx));
  app.route('/', adminRoutes(ctx));
  app.route('/', galleryAdminRoutes(ctx));
  app.route('/', conversationRoutes(ctx));
  app.route('/', fileRoutes(ctx));
  app.route('/', galleryRoutes(ctx));
  app.route('/', mediaJobRoutes(ctx));
  app.route('/', faceRoutes(ctx));
  app.route('/', promptRoutes(ctx));
  app.route('/', webhookRoutes(ctx));
  return app;
}
