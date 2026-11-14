import { Hono } from 'hono';
import { z } from 'zod';
import { verifyPassword } from '../../auth/auth.js';
import type { AppContext } from '../../context.js';
import { badRequest, unauthorized } from '../../errors.js';
import type { Env } from '../../http.js';
import { body, userView } from './util.js';

const PASSWORD = z.string().min(8, 'password must be at least 8 characters').max(200);

/** POST /auth/login|refresh|logout — the only unauthenticated native routes. */
export function authRoutes(ctx: AppContext) {
  const app = new Hono<Env>();

  app.post('/auth/login', async (c) => {
    const b = await body(c, z.object({ email: z.string().min(1), password: z.string().min(1) }));
    const { user, tokens } = await ctx.auth.login(b.email, b.password);
    return c.json({ user: userView(user), ...tokens });
  });

  app.post('/auth/refresh', async (c) => {
    const b = await body(c, z.object({ refresh_token: z.string().min(1) }));
    return c.json(await ctx.auth.refresh(b.refresh_token));
  });

  app.post('/auth/logout', async (c) => {
    const b = await body(c, z.object({ refresh_token: z.string().min(1) }));
    await ctx.auth.logout(b.refresh_token);
    return c.body(null, 204);
  });

  return app;
}

/** /me, /api-keys, /usage (any signed-in user; auth middleware is applied in index.ts). */
export function meRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  app.get('/me', async (c) => {
    const user = c.get('user');
    return c.json({ user: userView(user), usage: await ctx.usage.summary(user.id) });
  });

  app.patch('/me', async (c) => {
    const b = await body(
      c,
      z
        .object({ display_name: z.string().trim().max(100).nullable().optional(), password: PASSWORD.optional(), current_password: z.string().optional() })
        .strict(),
    );
    const user = c.get('user');
    if (b.password) {
      if (!b.current_password) throw badRequest('current_password is required to change the password', 'validation_error');
      if (!(await verifyPassword(b.current_password, user.passwordHash))) throw unauthorized('current_password is wrong');
    }
    const updated = await ctx.auth.updateUser(user.id, { displayName: b.display_name, password: b.password });
    return c.json({ user: userView(updated) });
  });

  app.get('/usage', async (c) => c.json(await ctx.usage.summary(c.get('user').id)));

  app.get('/api-keys', async (c) => {
    const keys = await ctx.auth.listApiKeys(c.get('user').id);
    return c.json({
      data: keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, created_at: k.createdAt.toISOString(), last_used_at: k.lastUsedAt?.toISOString() ?? null })),
    });
  });

  app.post('/api-keys', async (c) => {
    const b = await body(c, z.object({ name: z.string().trim().min(1, 'name is required').max(100) }));
    const k = await ctx.auth.createApiKey(c.get('user').id, b.name);
    return c.json({ id: k.id, name: k.name, prefix: k.prefix, key: k.key, created_at: k.createdAt.toISOString() }, 201);
  });

  app.delete('/api-keys/:id', async (c) => {
    await ctx.auth.revokeApiKey(c.get('user').id, c.req.param('id'));
    return c.body(null, 204);
  });

  return app;
}

/** /admin/* (role=admin; enforced in index.ts). */
export function adminRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  app.get('/admin/users', async (c) => {
    const users = await ctx.auth.listUsers();
    const withUsage = await Promise.all(users.map(async (u) => ({ ...userView(u), credits_used_this_month: await ctx.usage.monthToDate(u.id) })));
    return c.json({ data: withUsage });
  });

  app.post('/admin/users', async (c) => {
    const b = await body(
      c,
      z.object({
        email: z.email(),
        password: PASSWORD.optional(),
        display_name: z.string().trim().max(100).optional(),
        role: z.enum(['admin', 'user']).default('user'),
        monthly_credit_limit: z.number().nonnegative().nullable().optional(),
      }),
    );
    const user = await ctx.auth.createUser({ email: b.email, password: b.password, displayName: b.display_name, role: b.role, monthlyCreditLimit: b.monthly_credit_limit });
    return c.json({ user: userView(user) }, 201);
  });

  app.patch('/admin/users/:id', async (c) => {
    const b = await body(
      c,
      z
        .object({
          role: z.enum(['admin', 'user']).optional(),
          monthly_credit_limit: z.number().nonnegative().nullable().optional(),
          disabled: z.boolean().optional(),
          password: PASSWORD.optional(),
          display_name: z.string().trim().max(100).nullable().optional(),
        })
        .strict(),
    );
    const id = c.req.param('id');
    if (id === c.get('user').id && (b.role === 'user' || b.disabled)) throw badRequest('You cannot demote or disable yourself', 'cannot_modify_self');
    const user = await ctx.auth.updateUser(id, {
      role: b.role,
      monthlyCreditLimit: b.monthly_credit_limit,
      disabled: b.disabled,
      password: b.password,
      displayName: b.display_name,
    });
    return c.json({ user: userView(user) });
  });

  app.post('/admin/models/sync', async (c) => {
    const changes = await ctx.models.sync();
    return c.json({
      changes: changes.map((ch) => ({
        type: ch.type,
        model: { id: ch.model.id, display_name: ch.model.displayName },
        ...('previous' in ch ? { previous: { display_name: ch.previous.displayName } } : {}),
      })),
      active_models: ctx.models.listActive().length,
    });
  });

  return app;
}
