import { and, asc, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { type ContentBlock, compatThreads, conversations, messages } from '../db/schema.js';
import { notFound } from '../errors.js';
import { newId, sha256 } from '../ids.js';
import type { ProfileName } from './profiles.js';

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;

export interface CreateConversation {
  userId: string;
  profile: ProfileName;
  model: string;
  systemPrompt?: string | null;
  title?: string | null;
  source?: ConversationRow['source'];
  metadata?: Record<string, unknown>;
}

/** A provider-neutral view of one message of a stateless (OpenAI/Anthropic) history. */
export interface CompatMessage {
  role: 'user' | 'assistant';
  text: string;
  /** Stable digests of attached images/files (e.g. sha256 of bytes or URL). */
  attachments?: string[];
}

export class ConversationService {
  constructor(private readonly db: DB) {}

  async create(input: CreateConversation): Promise<ConversationRow> {
    const [row] = await this.db
      .insert(conversations)
      .values({
        id: newId('conv'),
        userId: input.userId,
        profile: input.profile,
        model: input.model,
        systemPrompt: input.systemPrompt ?? null,
        title: input.title ?? null,
        source: input.source ?? 'native',
        metadata: input.metadata ?? {},
      })
      .returning();
    return row!;
  }

  async get(id: string, userId?: string): Promise<ConversationRow> {
    const where = userId ? and(eq(conversations.id, id), eq(conversations.userId, userId)) : eq(conversations.id, id);
    const [row] = await this.db.select().from(conversations).where(and(where, isNull(conversations.archivedAt)));
    if (!row) throw notFound('Conversation');
    return row;
  }

  /** Newest first, cursor = updated_at ISO of the last item. Hidden (media-job) conversations are excluded. */
  async list(userId: string, opts: { limit?: number; before?: string } = {}) {
    const limit = Math.min(opts.limit ?? 20, 100);
    const conds = [
      eq(conversations.userId, userId),
      isNull(conversations.archivedAt),
      eq(conversations.source, 'native'),
      sql`coalesce(${conversations.metadata}->>'hidden', 'false') <> 'true'`,
    ];
    if (opts.before) conds.push(lt(conversations.updatedAt, new Date(opts.before)));
    const rows = await this.db.select().from(conversations).where(and(...conds)).orderBy(desc(conversations.updatedAt)).limit(limit + 1);
    return { data: rows.slice(0, limit), hasMore: rows.length > limit };
  }

  async update(id: string, userId: string, patch: Partial<Pick<ConversationRow, 'title' | 'model' | 'systemPrompt' | 'profile' | 'metadata'>>) {
    await this.get(id, userId);
    const [row] = await this.db
      .update(conversations)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(conversations.id, id))
      .returning();
    return row!;
  }

  async archive(id: string, userId: string) {
    await this.get(id, userId);
    await this.db.update(conversations).set({ archivedAt: new Date() }).where(eq(conversations.id, id));
  }

  async messages(conversationId: string, opts: { limit?: number } = {}): Promise<MessageRow[]> {
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt))
      .limit(Math.min(opts.limit ?? 200, 1000));
  }

  async addMessage(m: { conversationId: string; role: 'user' | 'assistant'; content: ContentBlock[] } & Partial<MessageRow>): Promise<MessageRow> {
    const [row] = await this.db
      .insert(messages)
      .values({ id: m.id ?? newId('msg'), ...m })
      .returning();
    return row!;
  }

  // ── stateless compat threads ────────────────────────────────────────────

  /** Fingerprint of a history prefix, scoped to user + profile + system prompt. */
  threadKey(userId: string, scope: string, history: CompatMessage[]): string {
    const norm = history.map((m) => [m.role, normalizeText(m.text), ...(m.attachments ?? [])]);
    return sha256(JSON.stringify([userId, scope, norm]));
  }

  async findThread(key: string, userId: string): Promise<ConversationRow | null> {
    const [hit] = await this.db
      .select({ conv: conversations })
      .from(compatThreads)
      .innerJoin(conversations, eq(compatThreads.conversationId, conversations.id))
      .where(and(eq(compatThreads.key, key), eq(compatThreads.userId, userId), isNull(conversations.archivedAt)));
    return hit?.conv ?? null;
  }

  async rememberThread(key: string, conversationId: string, userId: string) {
    await this.db
      .insert(compatThreads)
      .values({ key, conversationId, userId })
      .onConflictDoUpdate({ target: compatThreads.key, set: { conversationId, createdAt: new Date() } });
  }
}

/** Whitespace-insensitive so clients that re-format history still match. */
const normalizeText = (t: string) => t.replace(/\s+/g, ' ').trim();

/** Transcript used when a stateless client sends history we have never seen (cache miss). */
export function transcriptPreamble(history: CompatMessage[]): string {
  const lines = history.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`);
  return `Conversation so far (for context — continue from it):\n\n${lines.join('\n\n')}\n\n---\nNew message from the user:`;
}
