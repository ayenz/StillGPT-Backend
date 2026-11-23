import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makePng } from '../mock-qoder/index.js';
import { type Harness, startHarness } from './harness.js';
import { readSse } from './native-sse.js';

/* GET /files/:id → job_id: the gallery creation a file came from ("Made from" links in the PWA). */

const KEY = 'up-key';
let h: Harness;
let server: Server;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const reply = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (req.url === '/health/ready') return reply(200, { ready: true, upscale: { ready: true, device: 'cpu' } });
      const b = JSON.parse(raw);
      reply(200, { image: makePng(60, 80).toString('base64'), mime_type: 'image/jpeg', width: 60, height: 80, scale: b.scale, mode: b.mode, pipeline: 'P4', device: 'cpu' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  h = await startHarness({ env: { MEDIA_POLL_INTERVAL_MS: '50', FACESWAP_URL: url, FACESWAP_API_KEY: KEY } });
});
afterAll(async () => {
  await h?.close();
  await new Promise<void>((r) => server.close(() => r()));
});

const get = async (path: string) => {
  const res = await h.api(path);
  return { status: res.status, body: (await res.json()) as any };
};

describe('GET /files/:id job_id', () => {
  it('names the creation of an output, null for uploads; a trashed creation hides the file', async () => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(makePng(30, 40))], { type: 'image/png' }), 'photo.png');
    const upload = (await (await h.api('/api/v1/files', { method: 'POST', body: form })).json()) as { id: string };
    expect((await get(`/api/v1/files/${upload.id}`)).body.job_id).toBeNull();

    const started = (await (await h.api(`/api/v1/images/${upload.id}/upscale`, { method: 'POST', json: {} })).json()) as { id: string };
    await readSse(await h.api(`/api/v1/jobs/${started.id}/events`));
    const job = (await get(`/api/v1/jobs/${started.id}`)).body;
    const output = job.outputs[0].id as string;
    const file = await get(`/api/v1/files/${output}`);
    expect(file.status).toBe(200);
    expect(file.body).toMatchObject({ id: output, job_id: started.id, thumbnail_url: expect.any(String) });

    expect((await h.api(`/api/v1/jobs/${started.id}`, { method: 'DELETE' })).status).toBeLessThan(300);
    // trashing hides the creation's outputs too: the PWA then says "The original was deleted"
    expect((await get(`/api/v1/files/${output}`)).status).toBe(404);
  });
});
