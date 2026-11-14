import { Hono } from 'hono';
import type { AppContext } from '../../context.js';
import { AppError } from '../../errors.js';
import { type Env, requireUser } from '../../http.js';
import { chatCompletions } from './chat.js';
import { openaiMediaRoutes } from './media.js';
import { modelRoutes } from './models.js';
import { responses } from './responses.js';

const notSupported = (what: string) => () => {
  throw new AppError(501, 'not_supported', `${what} is not supported by StillGPT`);
};

/** OpenAI-compatible API, mounted at /v1. */
export function openaiRoutes(ctx: AppContext) {
  const app = new Hono<Env>();
  app.use('*', requireUser(ctx));

  app.route('/', modelRoutes(ctx));
  app.post('/chat/completions', chatCompletions(ctx));
  app.post('/responses', responses(ctx));
  app.post('/embeddings', notSupported('The embeddings API'));
  app.post('/completions', notSupported('The legacy completions API'));
  app.post('/audio/*', notSupported('The audio API'));
  app.route('/', openaiMediaRoutes(ctx));

  // Registered last: anything else under /v1 gets an OpenAI-style 404 instead of the native envelope.
  app.all('*', (c) => {
    throw new AppError(404, 'not_found', `Unknown route: ${c.req.method} ${c.req.path}`);
  });
  return app;
}
