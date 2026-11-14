import type { Context, MiddlewareHandler } from 'hono';
import type { UserRow } from './auth/auth.js';
import type { AppContext } from './context.js';
import { badRequest, forbidden, unauthorized } from './errors.js';

/** Hono environment shared by all routers. */
export type Env = { Variables: { user: UserRow; requestId: string } };

/**
 * Resolves the caller from `Authorization: Bearer <api key | access JWT>` or `x-api-key`
 * (Anthropic SDK style). Sets `c.get('user')`.
 */
export function requireUser(ctx: AppContext): MiddlewareHandler<Env> {
  return async (c, next) => {
    const header = c.req.header('authorization');
    const credential = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? c.req.header('x-api-key')?.trim();
    if (!credential) throw unauthorized();
    c.set('user', await ctx.auth.authenticate(credential));
    await next();
  };
}

export function requireAdmin(): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (c.get('user').role !== 'admin') throw forbidden('Admin only');
    await next();
  };
}

/** Parse a JSON body; malformed JSON becomes a 400 instead of a 500. */
export async function jsonBody<T = unknown>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw badRequest('Request body must be valid JSON', 'invalid_json');
  }
}
