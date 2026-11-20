import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors.js';
import { silentLogger } from '../../src/log.js';
import { FaceSwapClient } from '../../src/providers/faceswap.js';

const CPU = 'http://cpu:8080';
const GPU = 'http://gpu:8090';
const IMG = Buffer.from('img');

type Reply = { status: number; body: unknown } | 'throw';

/** fetch stub: per "<host> <path>" a queue of replies (the last one repeats); records the calls. */
function stub(replies: Record<string, Reply[]>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const key = `${u.origin} ${u.pathname}`;
    calls.push(`${init?.method ?? 'GET'} ${key}`);
    const q = replies[key];
    if (!q?.length) throw new Error(`unexpected ${key}`);
    const r = q.length > 1 ? q.shift()! : q[0]!;
    if (r === 'throw') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const swapped = (device: string) => ({
  status: 200,
  body: { image: Buffer.from(device).toString('base64'), mime_type: 'image/jpeg', width: 4, height: 3, target_faces: 1, source_faces: 1, device, timings_ms: { swap: 1 } },
});
const gpuReady = { status: 200, body: { ready: true, models: { device: 'cuda' } } };

function client(fetchImpl: typeof fetch, gpu = true) {
  return new FaceSwapClient({
    baseUrl: CPU,
    apiKey: 'cpu-key',
    log: silentLogger,
    fetchImpl,
    gpu: gpu ? { baseUrl: GPU, apiKey: 'gpu-key', timeoutMs: 5000 } : undefined,
  });
}

describe('FaceSwapClient GPU first', () => {
  it('swaps on the GPU box when it is ready with swap on CUDA', async () => {
    const s = stub({ [`${GPU} /health/ready`]: [gpuReady], [`${GPU} /v1/swap`]: [swapped('cuda')] });
    const r = await client(s.fetchImpl).swap(IMG, [IMG]);
    expect(r.backend).toBe('gpu');
    expect(r.bytes.toString()).toBe('cuda');
    expect(s.calls).toEqual([`GET ${GPU} /health/ready`, `POST ${GPU} /v1/swap`]);
  });

  it('uses the CPU sidecar when the GPU box runs upscale-only or is not ready', async () => {
    for (const health of [{ status: 200, body: { ready: true, mode: 'upscale_only' } }, { status: 503, body: { ready: false } }, 'throw' as const]) {
      const s = stub({ [`${GPU} /health/ready`]: [health], [`${CPU} /v1/swap`]: [swapped('cpu')] });
      const r = await client(s.fetchImpl).swap(IMG, [IMG]);
      expect(r.backend).toBe('cpu');
      expect(s.calls.filter((c) => c.includes('/v1/swap'))).toEqual([`POST ${CPU} /v1/swap`]);
    }
  });

  it('falls back to the CPU when the GPU call fails, and skips the GPU until the next probe', async () => {
    for (const fail of ['throw' as const, { status: 500, body: { detail: 'Internal Server Error' } }, { status: 503, body: { detail: 'MODELS_LOADING' } }, { status: 401, body: { detail: 'AUTH_INVALID' } }]) {
      const s = stub({ [`${GPU} /health/ready`]: [gpuReady], [`${GPU} /v1/swap`]: [fail], [`${CPU} /v1/swap`]: [swapped('cpu')] });
      const c = client(s.fetchImpl);
      expect((await c.swap(IMG, [IMG])).backend).toBe('cpu');
      expect((await c.swap(IMG, [IMG])).backend).toBe('cpu'); // marked down: no second GPU attempt within the cache window
      expect(s.calls.filter((x) => x.startsWith(`POST ${GPU}`))).toHaveLength(1);
    }
  });

  it('does not fall back on input rejections', async () => {
    const s = stub({ [`${GPU} /health/ready`]: [gpuReady], [`${GPU} /v1/swap`]: [{ status: 422, body: { detail: 'NO_FACE_IN_TARGET' } }] });
    const err = await client(s.fetchImpl).swap(IMG, [IMG]).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('no_face_in_target');
    expect(s.calls.some((c) => c.startsWith(`POST ${CPU}`))).toBe(false);
  });

  it('keeps crop and paste on the CPU sidecar, and works without a GPU configured', async () => {
    const s = stub({ [`${CPU} /v1/face-crop`]: [{ status: 200, body: { crop: 'eA==', box: [1, 2, 3, 3], faces: 1 } }], [`${CPU} /v1/swap`]: [swapped('cpu')] });
    await client(s.fetchImpl).crop(IMG);
    expect((await client(s.fetchImpl, false).swap(IMG, [IMG])).backend).toBe('cpu');
    expect(s.calls).toEqual([`POST ${CPU} /v1/face-crop`, `POST ${CPU} /v1/swap`]);
  });
});
