import { and, desc, eq, lt } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { INLINE_IMAGE_TYPES, SHRINKABLE_IMAGE_TYPES, UPLOAD_MAX } from '../../core/attachments.js';
import type { TurnHandle } from '../../core/turns.js';
import { type ContentBlock, messages } from '../../db/schema.js';
import { AppError, notFound } from '../../errors.js';
import type { Env } from '../../http.js';
import { imageProviders } from './media.js';
import { body, conversationView, limitParam, messageView, type SseEvent, sse, turnEventView, wantsStream } from './util.js';

/** GIFs above this are not inlined and would need an upstream upload (capped at 5 MB). Still images of any size are shrunk upstream. */
const IMAGE_MAX = 7 * 1024 * 1024;
const MAX_BLOCKS = 50;

const createSchema = z
  .object({
    title: z.string().trim().max(200).nullable().optional(),
    model: z.string().trim().min(1).max(100).optional(),
    profile: z.enum(['chat', 'assistant']).optional(),
    system_prompt: z.string().max(20_000).nullable().optional(),
  })
  .strict();

const blockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), file_id: z.string().min(1) }),
  z.object({ type: z.literal('file'), file_id: z.string().min(1) }),
]);

const messageSchema = z
  .object({
    content: z.array(blockSchema).min(1).max(MAX_BLOCKS).optional(),
    text: z.string().optional(),
    attachments: z.array(z.string().min(1)).max(MAX_BLOCKS).optional(),
  })
  .refine((b) => b.content || b.text !== undefined || b.attachments?.length, { message: 'Send `content` blocks or `text` (+ `attachments`)' });

type MessageInput = z.infer<typeof messageSchema>;

export function conversationRoutes(ctx: AppContext) {
  const app = new Hono<Env>();

  app.get('/models', (c) => {
    const data = ctx.models.listActive().map((m) => ({
      id: m.id,
      display_name: m.displayName,
      price_factor: m.priceFactor,
      vision: m.isVision,
      efforts: m.efforts ?? [],
      default_effort: m.defaultEffort,
      context_window: m.defaultContextWindow,
      max_input_tokens: m.maxInputTokens,
      is_new: m.isNew,
    }));
    const aliases = ctx.models.aliasList().map((a) => ({ alias: a.alias, resolves_to: a.resolvesTo, chain: a.chain }));
    return c.json({ data, aliases, default_model: 'default', ...imageProviders(ctx) });
  });

  app.get('/conversations', async (c) => {
    const before = c.req.query('before');
    if (before && Number.isNaN(Date.parse(before))) throw new AppError(400, 'validation_error', 'before must be an ISO timestamp (next_cursor)');
    const page = await ctx.conversations.list(c.get('user').id, { limit: limitParam(c.req.query('limit'), 20, 100), before });
    const last = page.data.at(-1);
    return c.json({ data: page.data.map(conversationView), has_more: page.hasMore, next_cursor: page.hasMore && last ? last.updatedAt.toISOString() : null });
  });

  app.post('/conversations', async (c) => {
    const b = await body(c, createSchema);
    if (b.model) ctx.models.resolve(b.model); // rejects media models early; unknown ids fall back at turn time
    const conv = await ctx.conversations.create({
      userId: c.get('user').id,
      profile: b.profile ?? ctx.config.DEFAULT_PROFILE_NATIVE,
      model: b.model ?? 'default',
      systemPrompt: b.system_prompt ?? null,
      title: b.title ?? null,
    });
    return c.json(conversationView(conv), 201);
  });

  app.get('/conversations/:id', async (c) => c.json(conversationView(await ownConversation(ctx, c))));

  app.patch('/conversations/:id', async (c) => {
    const b = await body(c, createSchema);
    if (b.model) ctx.models.resolve(b.model);
    const conv = await ownConversation(ctx, c);
    const updated = await ctx.conversations.update(conv.id, conv.userId, {
      // a manual rename (or clearing) pins the title: the auto titler never overwrites it
      ...(b.title !== undefined ? { title: b.title, metadata: { ...conv.metadata, title_source: 'user' } } : {}),
      ...(b.model ? { model: b.model } : {}),
      ...(b.profile ? { profile: b.profile } : {}),
      ...(b.system_prompt !== undefined ? { systemPrompt: b.system_prompt } : {}),
    });
    return c.json(conversationView(updated));
  });

  app.delete('/conversations/:id', async (c) => {
    const conv = await ownConversation(ctx, c);
    await ctx.conversations.archive(conv.id, conv.userId);
    // the chat is gone for the user → free its Qoder session now instead of waiting for housekeeping
    void ctx.turns.releaseSession(conv.id);
    return c.body(null, 204);
  });

  app.get('/conversations/:id/messages', async (c) => {
    const conv = await ownConversation(ctx, c);
    const limit = limitParam(c.req.query('limit'), 100, 500);
    const before = c.req.query('before');
    const conds = [eq(messages.conversationId, conv.id)];
    if (before) {
      const [ref] = await ctx.database.db.select({ createdAt: messages.createdAt }).from(messages).where(and(eq(messages.id, before), eq(messages.conversationId, conv.id)));
      if (!ref) throw notFound('Message');
      conds.push(lt(messages.createdAt, ref.createdAt));
    }
    const rows = await ctx.database.db.select().from(messages).where(and(...conds)).orderBy(desc(messages.createdAt)).limit(limit + 1);
    const page = rows.slice(0, limit).reverse();
    const handle = ctx.turns.get(conv.id);
    return c.json({
      data: page.map((m) => messageView(m, ctx.store)),
      has_more: rows.length > limit,
      conversation: conversationView(conv),
      running_turn: handle ? { message_id: handle.messageId, user_message_id: handle.userMessageId, events: handle.events.length } : null,
    });
  });

  app.post('/conversations/:id/messages', async (c) => {
    const conv = await ownConversation(ctx, c);
    const input = await body(c, messageSchema);
    const content = await toContentBlocks(ctx, conv.userId, input);
    // ChatGPT-style auto title: generated in parallel with the first reply, announced as `conversation.title`
    let titling: Promise<string | null> | null = null;
    const autoTitle = !!ctx.titler && !conv.title;
    const handle = await ctx.turns.start({
      conversationId: conv.id,
      userId: conv.userId,
      content,
      kind: 'chat',
      ...(autoTitle
        ? {
            beforeComplete: async () => {
              const title = titling ? await withTimeout(titling, ctx.config.AUTO_TITLE_WAIT_MS) : null;
              return title ? [{ type: 'conversation.title' as const, conversationId: conv.id, title }] : [];
            },
          }
        : {}),
    });
    if (autoTitle) titling = ctx.titler!.generate(conv.id, conv.userId, content);
    c.header('X-StillGPT-Conversation', conv.id);
    if (wantsStream(c)) return sse(c, (signal) => replay(handle, 0, signal));

    const result = await handle.done;
    const [msg] = await ctx.database.db.select().from(messages).where(eq(messages.id, result.messageId));
    if (!msg) throw new AppError(500, 'internal_error', 'Assistant message was not persisted');
    c.header('X-StillGPT-Model', result.model);
    c.header('X-StillGPT-Credits', String(result.credits.total));
    return c.json({ message: messageView(msg, ctx.store), conversation: conversationView(await ctx.conversations.get(conv.id)) });
  });

  app.get('/conversations/:id/stream', async (c) => {
    const conv = await ownConversation(ctx, c);
    const handle = ctx.turns.get(conv.id);
    if (!handle) return c.body(null, 204);
    const after = Number(c.req.header('last-event-id') ?? c.req.query('last_event_id') ?? 0);
    return sse(c, (signal) => replay(handle, Number.isFinite(after) && after > 0 ? after : 0, signal));
  });

  app.post('/conversations/:id/interrupt', async (c) => {
    const conv = await ownConversation(ctx, c);
    return c.json({ interrupted: await ctx.turns.interrupt(conv.id, conv.userId) });
  });

  return app;
}

const ownConversation = (ctx: AppContext, c: Context<Env>) => ctx.conversations.get(c.req.param('id')!, c.get('user').id);

/** Events of a turn as SSE frames; `id` is the 1-based sequence number (clients resume with Last-Event-ID). */
async function* replay(handle: TurnHandle, after: number, signal: AbortSignal): AsyncGenerator<SseEvent> {
  let seq = 0;
  for await (const e of handle.iterate(signal)) {
    seq++;
    if (seq > after) yield { event: e.type, data: turnEventView(e), id: seq };
  }
}

/** A requested block; `auto` = shorthand attachment (vision images → image, everything else → document). */
type Requested = { type: 'text'; text: string } | { type: 'image' | 'file' | 'auto'; file_id: string };

/** API blocks (file ids) → stored ContentBlocks; checks ownership and size limits up front. */
async function toContentBlocks(ctx: AppContext, userId: string, input: MessageInput): Promise<ContentBlock[]> {
  const requested: Requested[] = input.content ?? [
    ...(input.text ? [{ type: 'text' as const, text: input.text }] : []),
    ...(input.attachments ?? []).map((id) => ({ type: 'auto' as const, file_id: id })),
  ];

  const out: ContentBlock[] = [];
  for (const b of requested) {
    if (b.type === 'text') {
      if (b.text.trim()) out.push({ type: 'text', text: b.text });
      continue;
    }
    const file = await ctx.store.get(b.file_id, userId).catch(() => {
      throw new AppError(404, 'file_not_found', `File ${b.file_id} not found`);
    });
    const asImage = b.type === 'image' || (b.type === 'auto' && INLINE_IMAGE_TYPES.includes(file.mimeType));
    if (asImage) {
      if (file.size > IMAGE_MAX && !SHRINKABLE_IMAGE_TYPES.includes(file.mimeType)) throw tooLarge(file.filename, IMAGE_MAX, 'image');
      out.push({ type: 'image', fileId: file.id, mimeType: file.mimeType });
    } else {
      if (file.size > UPLOAD_MAX) throw tooLarge(file.filename, UPLOAD_MAX, 'document');
      out.push({ type: 'document', fileId: file.id, filename: file.filename, mimeType: file.mimeType });
    }
  }
  if (!out.length) throw new AppError(400, 'empty_message', 'Message has no content');
  return out;
}

const tooLarge = (name: string, max: number, what: string) =>
  new AppError(413, 'attachment_too_large', `${name} exceeds the ${what} limit of ${max / 1024 / 1024} MB`);

/** Resolves to the promise's value, or null if it takes longer than `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(null); },
    );
  });
}
