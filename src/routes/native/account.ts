import { Hono } from 'hono';
import { z } from 'zod';
import { verifyPassword } from '../../auth/auth.js';
import type { AppContext } from '../../context.js';
import { type HousekeepingReport, type HousekeepingStatus, INTERVAL_HOURS_MAX, RETENTION_HOURS_MAX } from '../../core/housekeeping.js';
import { HISTORY_PAGE_SIZE_MAX, type QoderCreditHistory, type QoderCreditsStatus, type QuotaSummary } from '../../core/qoderCredits.js';
import { badRequest, unauthorized } from '../../errors.js';
import type { Env } from '../../http.js';
import { body, parse, userView } from './util.js';

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

  app.get('/admin/housekeeping', async (c) => c.json(housekeepingView(await ctx.housekeeper.status())));

  app.patch('/admin/housekeeping', async (c) => {
    const b = await body(
      c,
      z
        .object({
          enabled: z.boolean().optional(),
          retention_hours: z.number().int().min(1).max(RETENTION_HOURS_MAX).optional(),
          interval_hours: z.number().int().min(1).max(INTERVAL_HOURS_MAX).optional(),
        })
        .strict(),
    );
    const status = await ctx.housekeeper.updateSettings({ enabled: b.enabled, retentionHours: b.retention_hours, intervalHours: b.interval_hours });
    return c.json(housekeepingView(status));
  });

  /** Run a pass now. `dry_run: true` only reports what it would do; `retention_hours` previews another window. */
  app.post('/admin/housekeeping/run', async (c) => {
    const raw = (await c.req.text()).trim();
    let input: unknown = {};
    try {
      if (raw) input = JSON.parse(raw);
    } catch {
      throw badRequest('Request body must be valid JSON', 'invalid_json');
    }
    const b = parse(z.object({ dry_run: z.boolean().default(false), retention_hours: z.number().int().min(1).max(RETENTION_HOURS_MAX).optional() }).strict(), input);
    const report = await ctx.housekeeper.run({ dryRun: b.dry_run, retentionHours: b.retention_hours, trigger: 'manual' });
    return c.json({ report: reportView(report), ...housekeepingView(await ctx.housekeeper.status()) });
  });

  /** Remaining Qoder credits (cached 5 min; `?refresh=true` fetches now). Always 200: branch on `status`. */
  app.get('/admin/qoder/credits', async (c) => {
    const refresh = ['1', 'true'].includes(c.req.query('refresh') ?? '');
    return c.json(creditsView(await ctx.qoderCredits.status({ refresh })));
  });

  /** Qoder's per-request credit history, one page at a time. Always 200: branch on `status`. */
  app.get('/admin/qoder/credits/history', async (c) => {
    const msTime = z.string().regex(/^\d{10,13}$/).transform((v) => new Date(v.length === 10 ? Number(v) * 1000 : Number(v)));
    const q = parse(
      z
        .object({
          page: z.coerce.number().int().min(1).default(1),
          page_size: z.coerce.number().int().min(1).max(HISTORY_PAGE_SIZE_MAX).default(50),
          start: z.union([msTime, z.coerce.date()]).optional(),
          end: z.union([msTime, z.coerce.date()]).optional(),
          order: z.enum(['asc', 'desc']).default('desc'),
        })
        .strict()
        .refine((v) => !v.start || !v.end || v.start <= v.end, { message: 'start must be before end', path: ['start'] }),
      c.req.query(),
    );
    return c.json(historyView(await ctx.qoderCredits.history({ page: q.page, pageSize: q.page_size, start: q.start, end: q.end, order: q.order })));
  });

  /** Replace the qoder.com session cookie (bare value, `qoder_session_cookie=…` or a whole Cookie header). */
  app.put('/admin/qoder/session', async (c) => {
    const b = await body(c, z.object({ cookie: z.string().trim().min(20, 'cookie looks too short').max(8000) }).strict());
    return c.json(creditsView(await ctx.qoderCredits.setSession(b.cookie)));
  });

  /** Forget the admin-set cookie; QODER_WEB_SESSION (if any) applies again. */
  app.delete('/admin/qoder/session', async (c) => c.json(creditsView(await ctx.qoderCredits.setSession(null))));

  return app;
}

function historyView(h: QoderCreditHistory) {
  return {
    status: h.status,
    error: h.error,
    items: h.items.map((i) => ({
      begin_at: i.beginAt,
      finish_at: i.finishAt,
      session_id: i.sessionId,
      business_id: i.businessId,
      source: i.source,
      operation: i.operation,
      kind: i.kind,
      model: i.model,
      credits: i.credits,
      original_credits: i.originalCredits,
      cost: i.cost,
      original_cost: i.originalCost,
      discount_factor: i.discountFactor,
    })),
    page_summary: h.pageSummary
      ? { credits: h.pageSummary.credits, original_credits: h.pageSummary.originalCredits, cost: h.pageSummary.cost, original_cost: h.pageSummary.originalCost }
      : null,
    page: h.page ? { current: h.page.current, page_size: h.page.pageSize, last_page: h.page.lastPage, total_items: h.page.totalItems } : null,
  };
}

function quotaView(q: QuotaSummary) {
  return { used: q.used, limit: q.limit, remaining: q.remaining, usage_percentage: q.usagePercentage };
}

function creditsView(s: QoderCreditsStatus) {
  const c = s.credits;
  return {
    status: s.status,
    credits: c
      ? {
          ...quotaView(c),
          unit: c.unit,
          plan: quotaView(c.plan),
          resource_package: quotaView(c.resourcePackage),
          dedicated_resource_package: quotaView(c.dedicatedResourcePackage),
          last_reset_at: c.lastResetAt,
          next_reset_at: c.nextResetAt,
        }
      : null,
    stale: s.stale,
    fetched_at: s.fetchedAt,
    error: s.error,
    session: { configured: s.session.configured, source: s.session.source, issued_at: s.session.issuedAt, updated_at: s.session.updatedAt },
  };
}

function reportView(r: HousekeepingReport) {
  return {
    dry_run: r.dryRun,
    sessions_archived: r.sessionsArchived,
    files_deleted: r.filesDeleted,
    files_in_use: r.filesInUse,
    bytes_freed: r.bytesFreed,
    errors: r.errors,
  };
}

function housekeepingView(s: HousekeepingStatus) {
  return {
    settings: { enabled: s.settings.enabled, retention_hours: s.settings.retentionHours, interval_hours: s.settings.intervalHours },
    source: s.source,
    running: s.running,
    next_run_at: s.nextRunAt,
    last_run: s.lastRun
      ? {
          at: s.lastRun.at,
          trigger: s.lastRun.trigger,
          retention_hours: s.lastRun.retentionHours,
          report: s.lastRun.report ? reportView(s.lastRun.report) : null,
          error: s.lastRun.error ?? null,
        }
      : null,
  };
}
