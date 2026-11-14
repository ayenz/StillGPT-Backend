import { and, eq, gte, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { usageEvents, users } from '../db/schema.js';
import { AppError } from '../errors.js';
import { newId } from '../ids.js';
import type { Credits } from './events.js';

export interface UsageRecord {
  userId: string;
  kind: 'chat' | 'image' | 'video';
  model?: string | null;
  conversationId?: string | null;
  jobId?: string | null;
  credits: Credits;
  /** Record even at 0 credits (free providers), so the request still shows up in the usage counts. */
  free?: boolean;
}

const monthStart = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
};

/** Credit accounting (Qoder credits as reported by session.usage) + per-user monthly limits. */
export class UsageService {
  constructor(private readonly db: DB) {}

  async record(u: UsageRecord) {
    if (!u.free && u.credits.total <= 0 && u.credits.model <= 0 && u.credits.sandbox <= 0) return;
    await this.db.insert(usageEvents).values({
      id: newId('use'),
      userId: u.userId,
      kind: u.kind,
      model: u.model ?? null,
      conversationId: u.conversationId ?? null,
      jobId: u.jobId ?? null,
      creditsModel: u.credits.model,
      creditsSandbox: u.credits.sandbox,
      creditsTotal: u.credits.total,
    });
  }

  async monthToDate(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<number>`coalesce(sum(${usageEvents.creditsTotal}), 0)` })
      .from(usageEvents)
      .where(and(eq(usageEvents.userId, userId), gte(usageEvents.createdAt, monthStart())));
    return Number(row?.total ?? 0);
  }

  async summary(userId: string) {
    const rows = await this.db
      .select({ kind: usageEvents.kind, total: sql<number>`coalesce(sum(${usageEvents.creditsTotal}), 0)`, count: sql<number>`count(*)` })
      .from(usageEvents)
      .where(and(eq(usageEvents.userId, userId), gte(usageEvents.createdAt, monthStart())))
      .groupBy(usageEvents.kind);
    const [user] = await this.db.select({ limit: users.monthlyCreditLimit }).from(users).where(eq(users.id, userId));
    const used = rows.reduce((s, r) => s + Number(r.total), 0);
    return {
      period_start: monthStart().toISOString(),
      credits_used: round(used),
      credits_limit: user?.limit ?? null,
      by_kind: Object.fromEntries(rows.map((r) => [r.kind, { credits: round(Number(r.total)), requests: Number(r.count) }])),
    };
  }

  /** Throws 429 `credit_limit_exceeded` when the user's monthly limit is used up. */
  async assertWithinLimit(userId: string) {
    const [user] = await this.db.select({ limit: users.monthlyCreditLimit }).from(users).where(eq(users.id, userId));
    if (user?.limit == null) return;
    const used = await this.monthToDate(userId);
    if (used >= user.limit) {
      throw new AppError(429, 'credit_limit_exceeded', `Monthly credit limit reached (${round(used)}/${user.limit})`);
    }
  }
}

const round = (n: number) => Math.round(n * 10000) / 10000;
