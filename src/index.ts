import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createContext } from './context.js';

const config = loadConfig();
const ctx = await createContext(config);
await ctx.start();
const app = createApp(ctx);

const server = serve({ fetch: app.fetch, port: config.PORT, hostname: '0.0.0.0' }, (info) =>
  ctx.log.info('stillgpt.listening', { port: info.port, publicBaseUrl: config.PUBLIC_BASE_URL }),
);
// Long SSE turns (video ≈ minutes) must not be cut by Node's default request timeout.
(server as unknown as { requestTimeout: number }).requestTimeout = 0;

const shutdown = async (signal: string) => {
  ctx.log.info('stillgpt.shutdown', { signal });
  server.close();
  await ctx.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
