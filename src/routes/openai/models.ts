import { Hono } from 'hono';
import type { AppContext } from '../../context.js';
import { FOLAX_IMAGE_MODEL, FOLAX_VIDEO_MODEL, IMAGE_MODEL, type ModelRow, VIDEO_MODEL, VIRTUAL_CHAT_MODELS } from '../../core/models.js';
import { AppError, anthropicErrorBody } from '../../errors.js';
import type { Env } from '../../http.js';
import { FOLAX_CHAT_MODELS, FOLAX_MODEL_PREFIX } from '../../core/folaxChat.js';
import { publicModelId } from './turn.js';

interface ModelEntry {
  id: string;
  displayName: string;
  created: number;
  extra: {
    display_name: string;
    kind: 'alias' | 'model' | 'image' | 'video';
    /** Absent = Qoder; `stillgpt` = a virtual model StillGPT runs over many models (council). */
    provider?: 'folax' | 'stillgpt';
    /** Folax chat models: no tools / documents, server-forced "Folax by Infinix" persona. */
    tools?: boolean;
    resolves_to?: string;
    price_factor?: number | null;
    vision?: boolean;
    efforts?: string[] | null;
  };
}

const toSec = (d: Date | null | undefined) => Math.floor((d?.getTime() ?? 0) / 1000);

function modelEntry(m: ModelRow): ModelEntry {
  return {
    id: publicModelId(m.id),
    displayName: m.displayName,
    created: toSec(m.firstSeenAt),
    extra: { display_name: m.displayName, kind: 'model', price_factor: m.priceFactor, vision: m.isVision, efforts: m.efforts },
  };
}

/** Aliases that currently resolve, then every active Qoder model, then the virtual media models. */
function catalog(ctx: AppContext, bootSec: number): ModelEntry[] {
  const aliases = ctx.models.aliasList().flatMap(({ alias, resolvesTo }): ModelEntry[] => {
    const target = resolvesTo ? ctx.models.get(resolvesTo) : undefined;
    if (!target) return [];
    const base = modelEntry(target);
    return [{ ...base, id: alias, displayName: `${alias} → ${target.displayName}`, extra: { ...base.extra, kind: 'alias', resolves_to: publicModelId(target.id) } }];
  });
  const media = (id: string, kind: 'image' | 'video', name: string): ModelEntry => ({ id, displayName: name, created: bootSec, extra: { display_name: name, kind } });
  return [
    ...aliases,
    ...ctx.models.listActive().map(modelEntry),
    ...(ctx.folax
      ? FOLAX_CHAT_MODELS.map(
          (m): ModelEntry => ({
            id: FOLAX_MODEL_PREFIX + m.id,
            displayName: `${m.name} (via Folax)`,
            created: bootSec,
            extra: { display_name: `${m.name} (via Folax)`, kind: 'model', provider: 'folax', price_factor: 0, vision: true, efforts: null, tools: false },
          }),
        )
      : []),
    ...VIRTUAL_CHAT_MODELS.map(
      (m): ModelEntry => ({ id: m.id, displayName: m.name, created: bootSec, extra: { display_name: m.name, kind: 'model', provider: 'stillgpt', price_factor: 0, vision: true, efforts: null } }),
    ),
    media(IMAGE_MODEL, 'image', 'Qoder Image (ImageGen)'),
    ...(ctx.folax ? [media(FOLAX_IMAGE_MODEL, 'image', 'Folax Image (fast, 2 images per call; edits: 1 input image, shared weekly quota)')] : []),
    media(VIDEO_MODEL, 'video', 'Qoder Video (VideoGen)'),
    ...(ctx.folax ? [media(FOLAX_VIDEO_MODEL, 'video', 'Folax Video (image-to-video, 5 s 720p, watermark, shared weekly quota)')] : []),
  ];
}

const openaiModel = (m: ModelEntry) => ({ id: m.id, object: 'model', created: m.created, owned_by: m.extra.provider ?? 'qoder', stillgpt: m.extra });
const anthropicModel = (m: ModelEntry) => ({
  type: 'model',
  id: m.id,
  display_name: m.displayName,
  created_at: new Date(m.created * 1000).toISOString(),
  stillgpt: m.extra,
});

/**
 * GET /models, GET /models/:id. The Anthropic SDK calls the same path, so a request carrying
 * `anthropic-version` gets the Anthropic shape (and Anthropic error envelope) instead.
 */
export function modelRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  const bootSec = Math.floor(Date.now() / 1000);

  app.get('/models', (c) => {
    const list = catalog(ctx, bootSec);
    if (!c.req.header('anthropic-version')) return c.json({ object: 'list', data: list.map(openaiModel) });
    return c.json({ data: list.map(anthropicModel), has_more: false, first_id: list[0]?.id ?? null, last_id: list.at(-1)?.id ?? null });
  });

  app.get('/models/:id{.+}', (c) => {
    const id = c.req.param('id');
    const list = catalog(ctx, bootSec);
    const hit = list.find((m) => m.id === id) ?? list.find((m) => m.id === publicModelId(id));
    const anthropic = !!c.req.header('anthropic-version');
    if (!hit) {
      const err = new AppError(404, 'model_not_found', `The model '${id}' does not exist`);
      if (anthropic) return c.json(anthropicErrorBody(err), 404);
      throw err;
    }
    return c.json(anthropic ? anthropicModel(hit) : openaiModel(hit));
  });

  return app;
}
