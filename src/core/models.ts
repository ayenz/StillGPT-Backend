import { eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { models } from '../db/schema.js';
import { badRequest } from '../errors.js';
import type { Logger } from '../log.js';
import type { QoderClient } from '../qoder/client.js';
import type { QoderModel } from '../qoder/types.js';

export type ModelRow = typeof models.$inferSelect;

export type ModelChange =
  | { type: 'model.added'; model: ModelRow }
  | { type: 'model.retired'; model: ModelRow }
  | { type: 'model.updated'; model: ModelRow; previous: { displayName: string } };

export interface Resolution {
  /** Qoder model id to use. */
  model: string;
  requested: string;
  /** Set when we could not honour the request and picked another model. */
  fallbackReason?: string;
}

/** Virtual model ids for media endpoints (not chat models). */
export const IMAGE_MODEL = 'qoder-image';
/** Listed only when Folax is configured. */
export const FOLAX_IMAGE_MODEL = 'folax-image';
export const VIDEO_MODEL = 'qoder-video';
/** OpenAI-compatible model id of Folax image-to-video (`provider: folax`). */
export const FOLAX_VIDEO_MODEL = 'folax-video';

/**
 * Mirrors Qoder `GET /models` into the DB and resolves what clients ask for.
 *
 * Seamless updates: clients use aliases (`smart`, `fast`, …) or ids; ids that Qoder retires are
 * transparently replaced by the `default` alias chain, and changes are reported via `onChange`
 * (wired to webhooks) so humans notice too.
 */
export class ModelRegistry {
  private active = new Map<string, ModelRow>();
  private lastSync = 0;
  private syncing?: Promise<ModelChange[]>;
  onChange: (changes: ModelChange[]) => void = () => {};

  constructor(
    private readonly db: DB,
    private readonly qoder: QoderClient,
    private readonly aliases: Record<string, string[]>,
    private readonly log: Logger,
  ) {}

  /** Load the DB snapshot so we can serve before the first upstream sync finishes. */
  async load() {
    const rows = await this.db.select().from(models).where(eq(models.status, 'active'));
    this.active = new Map(rows.map((r) => [r.id, r]));
  }

  sync(): Promise<ModelChange[]> {
    this.syncing ??= this.doSync().finally(() => (this.syncing = undefined));
    return this.syncing;
  }

  /** Re-sync if the snapshot is older than `maxAgeMs` (used after an upstream "model unavailable"). */
  async ensureFresh(maxAgeMs: number) {
    if (Date.now() - this.lastSync > maxAgeMs) await this.sync();
  }

  private async doSync(): Promise<ModelChange[]> {
    const upstream = (await this.qoder.listModels()).filter((m) => m.is_enabled !== false);
    const now = new Date();
    const existing = new Map((await this.db.select().from(models)).map((r) => [r.id, r]));
    const changes: ModelChange[] = [];

    for (const m of upstream) {
      const values = toRow(m, now);
      const prev = existing.get(m.id);
      const [row] = await this.db
        .insert(models)
        .values(values)
        .onConflictDoUpdate({ target: models.id, set: { ...values, firstSeenAt: undefined, status: 'active', retiredAt: null } })
        .returning();
      if (!prev || prev.status === 'retired') changes.push({ type: 'model.added', model: row! });
      else if (prev.displayName !== row!.displayName) changes.push({ type: 'model.updated', model: row!, previous: { displayName: prev.displayName } });
    }

    const liveIds = upstream.map((m) => m.id);
    const gone = [...existing.values()].filter((r) => r.status === 'active' && !liveIds.includes(r.id));
    if (gone.length) {
      const retired = await this.db
        .update(models)
        .set({ status: 'retired', retiredAt: now })
        .where(inArray(models.id, gone.map((g) => g.id)))
        .returning();
      for (const r of retired) changes.push({ type: 'model.retired', model: r });
    }

    await this.load();
    this.lastSync = Date.now();
    if (changes.length) {
      this.log.info('models.changed', { changes: changes.map((c) => `${c.type}:${c.model.id}`) });
      this.onChange(changes);
    }
    return changes;
  }

  /** Mark a model unusable right now (upstream rejected it) and refresh in the background. */
  async markUnavailable(id: string) {
    this.active.delete(id);
    await this.db.update(models).set({ status: 'retired', retiredAt: new Date() }).where(eq(models.id, id));
    this.sync().catch((err) => this.log.warn('models.sync_failed', { err }));
  }

  isActive = (id: string) => this.active.has(id);
  get = (id: string) => this.active.get(id);
  listActive = () => [...this.active.values()].sort((a, b) => a.id.localeCompare(b.id));

  aliasList(): { alias: string; resolvesTo: string | null; chain: string[] }[] {
    return Object.entries(this.aliases).map(([alias, chain]) => ({ alias, chain, resolvesTo: chain.find((id) => this.active.has(id)) ?? null }));
  }

  /**
   * Accepts an alias (`smart`), a Qoder id (`ultimate`) or a namespaced id (`qoder/ultimate`).
   * Unknown/retired ids fall back to the `default` chain instead of failing — callers see the
   * resolved model in responses and a `model.fallback` event.
   */
  resolve(requested: string | undefined | null): Resolution {
    const raw = (requested ?? '').trim() || 'default';
    const id = raw.replace(/^qoder\//, '');
    if (id === IMAGE_MODEL || id === FOLAX_IMAGE_MODEL || id === VIDEO_MODEL || id === FOLAX_VIDEO_MODEL) throw badRequest(`'${id}' is a media model; use the images/videos endpoints`, 'model_not_supported');

    const chain = this.aliases[id];
    if (chain) {
      const hit = chain.find((m) => this.active.has(m));
      if (hit) return { model: hit, requested: raw };
      return this.fallback(raw, `no model of alias '${id}' is available`);
    }
    if (this.active.has(id)) return { model: id, requested: raw };
    return this.fallback(raw, `model '${id}' is not available (retired or unknown)`);
  }

  private fallback(requested: string, reason: string): Resolution {
    const chain = this.aliases.default ?? [];
    const hit = chain.find((m) => this.active.has(m)) ?? this.listActive()[0]?.id;
    if (!hit) throw badRequest('No Qoder models are available right now', 'no_models_available');
    return { model: hit, requested, fallbackReason: reason };
  }
}

function toRow(m: QoderModel, now: Date): typeof models.$inferInsert {
  return {
    id: m.id,
    displayName: m.display_name ?? m.id,
    status: 'active',
    priceFactor: m.price_factor ?? null,
    isVision: !!m.is_vl,
    isNew: !!m.is_new,
    efforts: m.efforts ?? null,
    defaultEffort: m.default_effort ?? null,
    maxInputTokens: m.max_input_tokens ?? null,
    defaultContextWindow: m.default_context_window ?? null,
    raw: m as Record<string, unknown>,
    lastSeenAt: now,
  };
}
