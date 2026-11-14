import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODEL_UNAVAILABLE, type MockQoder, startMockQoder } from './index.js';
import { PNG_SIGNATURE } from './media.js';
import { frameJson, type SseFrame, SseConnection } from './sseClient.js';

let qoder: MockQoder;
const AUTH = { authorization: 'Bearer pt-test' };

beforeAll(async () => {
  qoder = await startMockQoder({ heartbeatMs: 100, imageDelayMs: 10, videoDelayMs: 20 });
});
afterAll(async () => {
  await qoder.close();
});

type Json = Record<string, any>;

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${qoder.url}${path}`, {
    method,
    headers: { ...AUTH, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as Json };
}

let envId: string | undefined;
async function newSession(agentBody: Json = {}, sessionBody: Json = {}): Promise<Json> {
  envId ??= (await api('POST', '/environments', { name: 'stillgpt' })).json.id as string;
  const agent = await api('POST', '/agents', { name: 'qr-chat', model: 'efficient', tools: [], ...agentBody });
  expect(agent.status).toBe(200);
  const sess = await api('POST', '/sessions', { agent: agent.json.id, environment_id: envId, ...sessionBody });
  expect(sess.status).toBe(200);
  return sess.json;
}

const say = (sessionId: string, text: string, extra: Json[] = []) =>
  api('POST', `/sessions/${sessionId}/events`, {
    events: [{ type: 'user.message', content: [{ type: 'text', text }, ...extra] }],
  });

/** Polls the buffered event list until an event of `type` shows up after `afterCount` events. */
async function waitFor(sessionId: string, type: string, afterCount = 0, timeoutMs = 5000): Promise<Json[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { json } = await api('GET', `/sessions/${sessionId}/events?limit=1000`);
    const events = json.data as Json[];
    if (events.slice(afterCount).some((e) => e.type === type)) return events;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${type}: ${events.map((e) => e.type).join(',')}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const turnText = (events: Json[]) =>
  events.filter((e) => e.type === 'agent.message').at(-1)?.content[0].text as string;

const stream = (sessionId: string, query = '', headers: Record<string, string> = {}) =>
  SseConnection.open(`${qoder.url}/sessions/${sessionId}/events/stream${query}`, { headers: { ...AUTH, ...headers } });

const notHeartbeat = (frames: SseFrame[]) => frames.filter((f) => f.event !== 'heartbeat');

describe('auth', () => {
  it('rejects missing or wrong bearer tokens with the error envelope', async () => {
    for (const headers of [{}, { authorization: 'Bearer nope' }] as Record<string, string>[]) {
      const res = await fetch(`${qoder.url}/models`, { headers });
      expect(res.status).toBe(401);
      const body = (await res.json()) as Json;
      expect(body.type).toBe('error');
      expect(typeof body.request_id).toBe('string');
      expect(body.error.type).toBe('authentication_error');
    }
  });

  it('failNext injects exactly one upstream error', async () => {
    qoder.failNext(/\/models$/, 503);
    const first = await api('GET', '/models');
    expect(first.status).toBe(503);
    expect(first.json.error.type).toBe('api_error');
    expect((await api('GET', '/models')).status).toBe(200);
  });
});

describe('models and validation', () => {
  it('lists the default models with realistic fields', async () => {
    const { json } = await api('GET', '/models');
    const ids = (json.data as Json[]).map((m) => m.id);
    expect(ids).toEqual(['auto', 'efficient', 'fast', 'ultimate', 'qfmodel', 'kmodel_latest', 'dfmodel']);
    expect(json.has_more).toBe(false);
    const efficient = (json.data as Json[]).find((m) => m.id === 'efficient')!;
    expect(efficient).toMatchObject({ type: 'model', display_name: 'Efficient', price_factor: 0, efforts: ['low', 'high'] });
  });

  it('validates agent model and tool names', async () => {
    const badModel = await api('POST', '/agents', { name: 'x', model: 'gpt-9' });
    expect(badModel.status).toBe(400);
    expect(badModel.json.error).toMatchObject({ type: 'invalid_request_error', message: MODEL_UNAVAILABLE });

    const badObj = await api('POST', '/agents', { name: 'x', model: { id: 'nope', effort: 'low' } });
    expect(badObj.json.error.message).toBe(MODEL_UNAVAILABLE);

    const okObj = await api('POST', '/agents', { name: 'x', model: { id: 'qfmodel', effort: 'low' } });
    expect(okObj.json.model).toEqual({ id: 'qfmodel', effort: 'low' });

    const badTool = await api('POST', '/agents', {
      name: 'x',
      model: 'efficient',
      tools: [{ type: 'agent_toolset_20260401', enabled_tools: ['Read', 'Teleport'] }],
    });
    expect(badTool.status).toBe(400);
    expect(badTool.json.error.message).toBe("unknown tool name 'Teleport'");
  });

  it('retired models disappear, fail validation and break existing sessions', async () => {
    qoder.addModel({ id: 'tmpmodel', display_name: 'Temp' });
    qoder.renameModel('tmpmodel', 'Temp v2');
    let list = (await api('GET', '/models')).json.data as Json[];
    expect(list.find((m) => m.id === 'tmpmodel')?.display_name).toBe('Temp v2');

    const sess = await newSession({ model: 'tmpmodel' });
    expect(sess.agent.model).toEqual({ id: 'tmpmodel', effective_context_window: 200000 });

    qoder.retireModel('tmpmodel');
    list = (await api('GET', '/models')).json.data as Json[];
    expect(list.some((m) => m.id === 'tmpmodel')).toBe(false);
    expect((await api('POST', '/agents', { name: 'y', model: 'tmpmodel' })).json.error.message).toBe(MODEL_UNAVAILABLE);

    await say(sess.id, 'hello');
    const events = await waitFor(sess.id, 'session.status_idle');
    const err = events.find((e) => e.type === 'session.error')!;
    expect(err.error.message).toBe(MODEL_UNAVAILABLE);
    expect(events.some((e) => e.type === 'agent.message')).toBe(false);
    expect((await api('GET', `/sessions/${sess.id}`)).json.status).toBe('idle');
  });
});

describe('sessions', () => {
  it('patches model / system / title / metadata and keeps validating', async () => {
    const sess = await newSession({}, { metadata: { a: '1', b: '2' } });
    const patched = await api(
      'POST',
      `/sessions/${sess.id}`,
      { agent: { model: { id: 'ultimate', effort: 'low' }, system: 'be brief' }, title: 'T', metadata: { b: null, c: '3' } },
      { 'x-qoder-beta': 'session-agent-patch-2026-07-21' },
    );
    expect(patched.status).toBe(200);
    expect(patched.json.agent.model).toEqual({ id: 'ultimate', effort: 'low', effective_context_window: 200000 });
    expect(patched.json.agent.system).toBe('be brief');
    expect(patched.json.title).toBe('T');
    expect(patched.json.metadata).toEqual({ a: '1', c: '3' });

    const bad = await api('POST', `/sessions/${sess.id}`, { agent: { model: 'nope' } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toBe(MODEL_UNAVAILABLE);

    await say(sess.id, 'hi');
    expect(turnText(await waitFor(sess.id, 'session.status_idle'))).toBe('[ultimate] Echo #1: hi');
    expect(qoder.state.requestLog.some((r) => r.headers['x-qoder-beta'] === 'session-agent-patch-2026-07-21')).toBe(true);
  });

  it('archives and deletes', async () => {
    const sess = await newSession();
    expect((await api('POST', `/sessions/${sess.id}/archive`)).json.archived_at).toBeTruthy();
    expect((await say(sess.id, 'x')).status).toBe(400);
    expect((await api('DELETE', `/sessions/${sess.id}`)).json.type).toBe('session_deleted');
    expect((await api('GET', `/sessions/${sess.id}`)).status).toBe(404);
  });
});

describe('events & streaming', () => {
  it('streams a full turn with text deltas in the real order', async () => {
    const sess = await newSession();
    const sse = await stream(sess.id, '?event_deltas[]=agent.message');
    expect(sse.response.headers.get('content-type')).toContain('text/event-stream');
    await say(sess.id, 'hello there');
    const frames = notHeartbeat(await sse.collectUntil((f) => f.event === 'session.status_idle'));
    sse.close();

    const buffered = frames.filter((f) => f.event !== 'event_start' && f.event !== 'event_delta');
    expect(buffered.map((f) => f.event)).toEqual([
      'user.message',
      'session.status_running',
      'session.thread_status_running',
      'span.model_request_start',
      'agent.thinking',
      'span.model_request_end',
      'agent.message',
      'session.thread_status_idle',
      'session.usage',
      'session.status_idle',
    ]);
    for (const f of buffered) expect(frameJson(f).id).toBe(f.id);

    const message = buffered.find((f) => f.event === 'agent.message')!;
    const text = '[efficient] Echo #1: hello there';
    expect(frameJson(message).content).toEqual([{ type: 'text', text }]);

    const starts = frames.filter((f) => f.event === 'event_start').map((f) => frameJson<Json>(f));
    expect(starts.map((s) => s.event.type)).toEqual(['agent.thinking', 'agent.message']);
    const deltas = frames.filter((f) => f.event === 'event_delta');
    expect(deltas.every((f) => f.id === message.id && frameJson(f).event_id === message.id)).toBe(true);
    expect(deltas.map((f) => frameJson<Json>(f).delta.content.text).join('')).toBe(text);
    expect(deltas.length).toBe(Math.ceil(text.length / 4));
    // deltas come before the buffered message
    expect(frames.indexOf(deltas.at(-1)!)).toBeLessThan(frames.indexOf(message));

    const usage = frameJson(buffered.find((f) => f.event === 'session.usage')!);
    expect(usage).toMatchObject({ model_credits: 0.01, sandbox_runtime_credits: 0, total_credits: 0.01 });
    expect(frameJson(buffered.at(-1)!).stop_reason).toEqual({ type: 'end_turn' });

    // The buffered list matches the stream and paginates ascending.
    const list = (await api('GET', `/sessions/${sess.id}/events?limit=3`)).json;
    expect(list.data.map((e: Json) => e.id)).toEqual(buffered.slice(0, 3).map((f) => f.id));
    expect(list.has_more).toBe(true);
    const rest = (await api('GET', `/sessions/${sess.id}/events?after_id=${list.last_id}`)).json;
    expect(rest.data.map((e: Json) => e.id)).toEqual(buffered.slice(3).map((f) => f.id));
  });

  it('resumes after Last-Event-ID', async () => {
    const sess = await newSession();
    await say(sess.id, 'one');
    const events = await waitFor(sess.id, 'session.status_idle');
    const cursor = events[2]!.id as string;

    const sse = await stream(sess.id, '', { 'last-event-id': cursor });
    const replayed = notHeartbeat(await sse.collectUntil((f) => f.event === 'session.status_idle'));
    expect(replayed.map((f) => f.id)).toEqual(events.slice(3).map((e) => e.id));

    // The same connection keeps receiving live events.
    await say(sess.id, 'two');
    const live = notHeartbeat(await sse.collectUntil((f) => f.event === 'session.status_idle'));
    sse.close();
    expect(live[0]!.event).toBe('user.message');
    expect(frameJson<Json>(live.find((f) => f.event === 'agent.message')!).content[0].text).toBe(
      '[efficient] Echo #2: two',
    );
  });

  it('does not replay without Last-Event-ID and sends heartbeats', async () => {
    const sess = await newSession();
    await say(sess.id, 'before');
    await waitFor(sess.id, 'session.status_idle');

    const sse = await stream(sess.id);
    const idle = await sse.collectFor(350);
    expect(idle.length).toBeGreaterThan(0);
    expect(idle.every((f) => f.event === 'heartbeat' && f.id === undefined && f.data === '{}')).toBe(true);

    await say(sess.id, 'after');
    const frames = notHeartbeat(await sse.collectUntil((f) => f.event === 'session.status_idle'));
    sse.close();
    expect(frames[0]!.event).toBe('user.message');
    expect(frames.some((f) => f.event === 'event_delta')).toBe(false); // no deltas requested
  });

  it('rejects a second user.message while a turn runs, and interrupts', async () => {
    const sess = await newSession();
    await say(sess.id, 'take your time [[slow]]');
    await waitFor(sess.id, 'agent.thinking');

    const conflict = await say(sess.id, 'me too');
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.type).toBe('conflict_error');

    const started = Date.now();
    await api('POST', `/sessions/${sess.id}/events`, { events: [{ type: 'user.interrupt' }] });
    const events = await waitFor(sess.id, 'session.status_idle');
    expect(Date.now() - started).toBeLessThan(900);
    expect(events.at(-1)!.stop_reason).toEqual({ type: 'interrupted' });
    expect(events.some((e) => e.type === 'agent.message')).toBe(false);

    await say(sess.id, 'again');
    expect(turnText(await waitFor(sess.id, 'agent.message'))).toBe('[efficient] Echo #2: again');
  });

  it('keeps conversation history and counts images', async () => {
    const sess = await newSession();
    const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
    let n = 0;
    for (const text of ['first', 'second']) {
      await say(sess.id, text, text === 'second' ? [img, img] : []);
      n = (await waitFor(sess.id, 'session.status_idle', n)).length;
    }
    await say(sess.id, 'recap [[history]]');
    const events = await waitFor(sess.id, 'session.status_idle', n);
    expect(events.filter((e) => e.type === 'agent.message')[1]!.content[0].text).toBe(
      '[efficient] Echo #2: second (saw 2 image(s))',
    );
    expect(turnText(events)).toBe('[efficient] Echo #3: recap [[history]]\nHistory: first | second');
  });

  it('[[error]] terminates the session; budget limits stop with budget_exceeded', async () => {
    const sess = await newSession();
    await say(sess.id, 'boom [[error]]');
    const events = await waitFor(sess.id, 'session.status_terminated');
    expect(events.find((e) => e.type === 'session.error')!.error).toEqual({ type: 'api_error', message: 'mock failure' });
    expect((await say(sess.id, 'more')).status).toBe(409);

    const capped = await newSession({}, { budget: { type: 'limit', max_credit_cost: '0.005' } });
    await say(capped.id, 'pricey');
    const capEvents = await waitFor(capped.id, 'session.status_idle');
    expect(capEvents.at(-1)!.stop_reason).toEqual({ type: 'budget_exceeded' });
  });
});

describe('files, resources and artifacts', () => {
  async function upload(content: Blob, name?: string) {
    const form = new FormData();
    form.append('file', content, 'notes.txt');
    if (name) form.append('name', name);
    const res = await fetch(`${qoder.url}/files`, { method: 'POST', headers: AUTH, body: form });
    return { status: res.status, json: (await res.json()) as Json };
  }

  it('uploads, mounts and reads files with [[doc]]', async () => {
    const up = await upload(new Blob(['hello world\nsecond line'], { type: 'text/plain' }), 'brief.txt');
    expect(up.status).toBe(200);
    expect(up.json).toMatchObject({ type: 'file', filename: 'brief.txt', size_bytes: 23, mime_type: 'text/plain', downloadable: false });
    expect((await api('GET', `/files/${up.json.id}`)).json.id).toBe(up.json.id);
    expect((await api('GET', `/files/${up.json.id}/content`)).status).toBe(403);

    const tooBig = await upload(new Blob([new Uint8Array(5 * 1024 * 1024 + 1)]));
    expect(tooBig.status).toBe(400);

    const sess = await newSession({ tools: [{ type: 'agent_toolset_20260401', enabled_tools: ['Read', 'Bash'] }] });
    const mount = await api('POST', `/sessions/${sess.id}/resources`, {
      type: 'file',
      file_id: up.json.id,
      mount_path: '/data/brief.txt',
    });
    expect(mount.json.id).toMatch(/^sesr_/);
    expect((await api('GET', `/sessions/${sess.id}/resources`)).json.data).toHaveLength(1);

    await say(sess.id, 'summarize [[doc]]');
    const events = await waitFor(sess.id, 'session.status_idle');
    const use = events.find((e) => e.type === 'agent.tool_use')!;
    expect(use.name).toBe('Bash');
    expect(events.find((e) => e.type === 'agent.tool_result')!.tool_use_id).toBe(use.id);
    expect(turnText(events)).toBe('[efficient] Echo #1: summarize [[doc]]\n/data/brief.txt: hello world');
  });

  it('generates a downloadable PNG artifact via ImageGen', async () => {
    const sess = await newSession({
      tools: [{ type: 'agent_toolset_20260401', enabled_tools: ['ImageGen', 'DeliverArtifacts'] }],
    });
    await say(sess.id, '[[image]] an orange cat size=1792x1024');
    const events = await waitFor(sess.id, 'session.status_idle');
    const types = events.map((e) => e.type);
    expect(types.indexOf('agent.artifact_delivered')).toBeLessThan(types.indexOf('agent.message'));

    const gen = events.find((e) => e.type === 'agent.tool_use' && e.name === 'ImageGen')!;
    expect(gen.input).toEqual({ name: 'an-orange-cat', prompt: 'an orange cat', size: '1792x1024' });
    expect(events.some((e) => e.type === 'agent.tool_use' && e.name === 'DeliverArtifacts')).toBe(true);

    const art = events.find((e) => e.type === 'agent.artifact_delivered')!;
    expect(art).toMatchObject({ original_filename: 'an-orange-cat.png', content_type: 'image/png' });
    const meta = (await api('GET', `/files/${art.file_id}`)).json;
    expect(meta).toMatchObject({ downloadable: true, scope: { id: sess.id, type: 'session' } });

    const content = (await api('GET', `/files/${art.file_id}/content`)).json;
    expect(typeof content.expires_at).toBe('string');
    const dl = await fetch(content.url); // presigned: no auth header
    expect(dl.headers.get('content-type')).toBe('image/png');
    const bytes = Buffer.from(await dl.arrayBuffer());
    expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(bytes.length).toBe(art.size);

    expect(events.find((e) => e.type === 'session.usage')!.total_credits).toBe(0.06);
    expect(events.find((e) => e.type === 'span.model_request_end')!.model_usage.credits).toBe(0.06);
  });

  it('generates an MP4 artifact via VideoGen for qr-video agents', async () => {
    const sess = await newSession({
      name: 'qr-video',
      tools: [{ type: 'agent_toolset_20260401', enabled_tools: ['VideoGen', 'DeliverArtifacts', 'Read', 'Glob'] }],
    });
    await say(sess.id, 'a sunrise seconds=3 ratio=9:16 resolution=720P');
    const events = await waitFor(sess.id, 'session.status_idle');
    const gen = events.find((e) => e.type === 'agent.tool_use' && e.name === 'VideoGen')!;
    expect(gen.input).toMatchObject({ duration_seconds: 3, ratio: '9:16', resolution: '720P', mode: 'text_to_video' });
    const art = events.find((e) => e.type === 'agent.artifact_delivered')!;
    expect(art.content_type).toBe('video/mp4');
    const dl = await fetch((await api('GET', `/files/${art.file_id}/content`)).json.url);
    const bytes = Buffer.from(await dl.arrayBuffer());
    expect(bytes.subarray(4, 8).toString('ascii')).toBe('ftyp');
    expect(events.find((e) => e.type === 'session.usage')!.total_credits).toBe(0.21);
  });
});
