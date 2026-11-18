import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makePng } from '../mock-qoder/index.js';
import { type Harness, startHarness } from './harness.js';
import { readSse, readSseUntil } from './native-sse.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ mock: { slowDelayMs: 600 } });
});
afterAll(() => h?.close());

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });

async function newConversation(extra: Record<string, unknown> = {}) {
  const res = await h.api('/api/v1/conversations', { method: 'POST', json: { profile: 'chat', ...extra } });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; profile: string; model: string };
}

async function upload(filename: string, bytes: Buffer | string, type: string) {
  const form = new FormData();
  form.append('file', new Blob([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)], { type }), filename);
  const res = await h.api('/api/v1/files', { method: 'POST', body: form });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; filename: string; mime_type: string; size: number; url: string };
}

describe('native auth', () => {
  it('logs in, rotates refresh tokens, logs out', async () => {
    const login = await json(await fetch(`${h.url}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'user@test.local', password: 'user-password-123' }) }));
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ token_type: 'Bearer', user: { email: 'user@test.local', role: 'user' } });
    expect(login.body.expires_in).toBeGreaterThan(0);

    const me = await json(await h.api('/api/v1/me', { key: login.body.access_token }));
    expect(me.body.user.id).toBe(h.userId);
    expect(me.body.usage).toHaveProperty('credits_used');

    const post = (path: string, payload: unknown) => fetch(`${h.url}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const refreshed = await json(await post('/auth/refresh', { refresh_token: login.body.refresh_token }));
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(login.body.refresh_token);
    // the old refresh token was rotated out
    expect((await post('/auth/refresh', { refresh_token: login.body.refresh_token })).status).toBe(401);

    expect((await post('/auth/logout', { refresh_token: refreshed.body.refresh_token })).status).toBe(204);
    expect((await post('/auth/refresh', { refresh_token: refreshed.body.refresh_token })).status).toBe(401);
  });

  it('rejects bad passwords and missing credentials with the native envelope', async () => {
    const res = await json(await fetch(`${h.url}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'user@test.local', password: 'nope' }) }));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });
    expect((await fetch(`${h.url}/api/v1/me`)).status).toBe(401);
    const invalid = await json(await h.api('/api/v1/auth/login', { method: 'POST', json: { email: 1 } }));
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('validation_error');
  });

  it('updates the profile; password change needs the current password', async () => {
    const created = await h.ctx.auth.createUser({ email: 'pw@test.local', password: 'first-password' });
    const key = (await h.ctx.auth.createApiKey(created.id, 't')).key;
    expect((await h.api('/api/v1/me', { method: 'PATCH', key, json: { password: 'second-password' } })).status).toBe(400);
    expect((await h.api('/api/v1/me', { method: 'PATCH', key, json: { password: 'second-password', current_password: 'wrong' } })).status).toBe(401);
    const ok = await json(await h.api('/api/v1/me', { method: 'PATCH', key, json: { display_name: 'Pat', password: 'second-password', current_password: 'first-password' } }));
    expect(ok.body.user.display_name).toBe('Pat');
    expect((await h.ctx.auth.login('pw@test.local', 'second-password')).user.id).toBe(created.id);
  });
});

describe('api keys', () => {
  it('creates (shown once), lists and revokes', async () => {
    const created = await json(await h.api('/api/v1/api-keys', { method: 'POST', json: { name: 'n8n' } }));
    expect(created.status).toBe(201);
    expect(created.body.key).toMatch(/^sg_/);
    const list = await json(await h.api('/api/v1/api-keys'));
    const listed = list.body.data.find((k: any) => k.id === created.body.id);
    expect(listed).toMatchObject({ name: 'n8n', prefix: created.body.key.slice(0, 10) });
    expect(listed.key).toBeUndefined();

    expect((await h.api('/api/v1/me', { key: created.body.key })).status).toBe(200);
    expect((await h.api(`/api/v1/api-keys/${created.body.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await h.api('/api/v1/me', { key: created.body.key })).status).toBe(401);
    expect((await h.api(`/api/v1/api-keys/${created.body.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('models', () => {
  it('lists active models, aliases and the default', async () => {
    const { body } = await json(await h.api('/api/v1/models'));
    expect(body.default_model).toBe('default');
    expect(body.data.map((m: any) => m.id)).toContain('efficient');
    expect(body.data[0]).toHaveProperty('price_factor');
    expect(body.data[0]).toHaveProperty('vision');
    const def = body.aliases.find((a: any) => a.alias === 'default');
    expect(def).toEqual({ alias: 'default', resolves_to: 'auto', chain: ['auto', 'efficient'] });
  });
});

describe('conversations', () => {
  it('CRUD with cursor pagination', async () => {
    const a = await newConversation({ title: 'A' });
    const b = await newConversation({ title: 'B', model: 'smart', system_prompt: 'Be brief.' });
    expect(b).toMatchObject({ model: 'smart', profile: 'chat' });
    const dflt = await json(await h.api('/api/v1/conversations', { method: 'POST', json: {} }));
    expect(dflt.body).toMatchObject({ model: 'default', profile: 'assistant' });

    const page1 = await json(await h.api('/api/v1/conversations?limit=2'));
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.has_more).toBe(true);
    const page2 = await json(await h.api(`/api/v1/conversations?limit=2&before=${encodeURIComponent(page1.body.next_cursor)}`));
    const ids = [...page1.body.data, ...page2.body.data].map((c: any) => c.id);
    expect(ids).toContain(a.id);
    expect(new Set(ids).size).toBe(ids.length);

    const patched = await json(await h.api(`/api/v1/conversations/${a.id}`, { method: 'PATCH', json: { title: 'Renamed', model: 'fast' } }));
    expect(patched.body).toMatchObject({ title: 'Renamed', model: 'fast' });
    expect((await json(await h.api(`/api/v1/conversations/${a.id}`))).body.title).toBe('Renamed');

    expect((await h.api(`/api/v1/conversations/${a.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await h.api(`/api/v1/conversations/${a.id}`)).status).toBe(404);
    // another user's conversation is invisible
    expect((await h.api(`/api/v1/conversations/${b.id}`, { key: h.admin.apiKey })).status).toBe(404);
    expect((await h.api('/api/v1/conversations', { method: 'POST', json: { model: 'qoder-image' } })).status).toBe(400);
  });

  it('streams a reply over SSE with ordered events and persists it', async () => {
    const conv = await newConversation();
    h.qoder.setReply((t) => (t.startsWith('Write a short title') ? '"Sapaan Halo Dunia".' : undefined));
    const res = await h.api(`/api/v1/conversations/${conv.id}/messages`, { method: 'POST', json: { text: 'halo dunia' }, headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const frames = await readSse(res);
    h.qoder.setReply(undefined);
    const types = frames.map((f) => f.event);
    expect(types[0]).toBe('turn.started');
    expect(types.at(-1)).toBe('turn.completed');
    expect(types.at(-2)).toBe('conversation.title'); // auto title arrives right before the turn completes
    expect(frames.at(-2)!.data).toEqual({ type: 'conversation.title', conversation_id: conv.id, title: 'Sapaan Halo Dunia' });
    expect(types.indexOf('text.delta')).toBeLessThan(types.indexOf('text.completed'));
    expect(frames.map((f) => Number(f.id))).toEqual(frames.map((_, i) => i + 1));
    expect(frames[0]!.data).toMatchObject({ type: 'turn.started', conversation_id: conv.id, model: 'auto' });
    const text = frames.filter((f) => f.event === 'text.delta').map((f) => f.data.text).join('');
    expect(text).toBe('[auto] Echo #1: halo dunia');
    const done = frames.at(-1)!.data;
    expect(done).toMatchObject({ stop_reason: 'end_turn', text, credits: { total: 0.01 } });

    const msgs = await json(await h.api(`/api/v1/conversations/${conv.id}/messages`));
    expect(msgs.body.data.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs.body.data[1]).toMatchObject({ id: done.message_id, content: [{ type: 'text', text }], stop_reason: 'end_turn' });
    expect(msgs.body.running_turn).toBeNull();
    expect(msgs.body.conversation.title).toBe('Sapaan Halo Dunia');
  });

  it('returns JSON when not streaming (?stream=false) and supports content blocks', async () => {
    const conv = await newConversation();
    const r = await json(await h.api(`/api/v1/conversations/${conv.id}/messages`, { method: 'POST', json: { content: [{ type: 'text', text: 'satu' }] } }));
    expect(r.status).toBe(200);
    expect(r.body.message).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: '[auto] Echo #1: satu' }], credits: 0.01 });
    expect(r.body.conversation).toMatchObject({ id: conv.id, status: 'idle', resolved_model: 'auto' });

    const second = await h.api(`/api/v1/conversations/${conv.id}/messages?stream=true`, { method: 'POST', json: { text: 'dua [[history]]' } });
    const frames = await readSse(second);
    expect(frames.at(-1)!.data.text).toContain('History: satu');

    const empty = await json(await h.api(`/api/v1/conversations/${conv.id}/messages`, { method: 'POST', json: { text: '   ' } }));
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('empty_message');
  });

  it('keeps running after the client disconnects; reattach replays from Last-Event-ID', async () => {
    const conv = await newConversation();
    const res = await h.api(`/api/v1/conversations/${conv.id}/messages`, { method: 'POST', json: { text: 'pelan [[slow]]' }, headers: { accept: 'text/event-stream' } });
    const first = await readSseUntil(res, (f) => f.event === 'turn.started');
    expect(first.at(-1)!.id).toBe('1');

    const running = await json(await h.api(`/api/v1/conversations/${conv.id}/messages`));
    expect(running.body.running_turn).toMatchObject({ message_id: first[0]!.data.message_id });
    expect(running.body.conversation.status).toBe('busy');

    const again = await h.api(`/api/v1/conversations/${conv.id}/stream`, { headers: { 'last-event-id': '1' } });
    expect(again.status).toBe(200);
    const rest = await readSse(again);
    expect(rest[0]!.id).toBe('2');
    expect(rest.some((f) => f.event === 'turn.started')).toBe(false);
    expect(rest.at(-1)).toMatchObject({ event: 'turn.completed', data: { stop_reason: 'end_turn' } });

    expect((await h.api(`/api/v1/conversations/${conv.id}/stream`)).status).toBe(204);
  });

  it('interrupts a running turn', async () => {
    const conv = await newConversation();
    const res = await h.api(`/api/v1/conversations/${conv.id}/messages`, { method: 'POST', json: { text: 'lama [[slow]]' }, headers: { accept: 'text/event-stream' } });
    const stream = readSse(res);
    await new Promise((r) => setTimeout(r, 150));
    const busy = await json(await h.api(`/api/v1/conversations/${conv.id}/messages`, { method: 'POST', json: { text: 'x' } }));
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('conversation_busy');
    const intr = await json(await h.api(`/api/v1/conversations/${conv.id}/interrupt`, { method: 'POST' }));
    expect(intr.body).toEqual({ interrupted: true });
    const frames = await stream;
    expect(frames.at(-1)).toMatchObject({ event: 'turn.completed', data: { stop_reason: 'interrupted' } });
    expect((await json(await h.api(`/api/v1/conversations/${conv.id}/interrupt`, { method: 'POST' }))).body).toEqual({ interrupted: false });
  });
});

describe('files and attachments', () => {
  it('uploads files and sends images (vision) and documents (sandbox)', async () => {
    const png = await upload('kucing.png', makePng(), 'image/png');
    expect(png).toMatchObject({ filename: 'kucing.png', mime_type: 'image/png' });
    expect((await fetch(png.url)).status).toBe(200);
    const doc = await upload('notes.txt', 'first line of notes\nsecond', 'application/octet-stream');
    expect(doc.mime_type).toBe('text/plain');
    expect((await json(await h.api(`/api/v1/files/${doc.id}`))).body.id).toBe(doc.id);
    expect((await h.api(`/api/v1/files/${doc.id}`, { key: h.admin.apiKey })).status).toBe(404);

    const conv = await newConversation();
    const img = await json(await h.api(`/api/v1/conversations/${conv.id}/messages`, { method: 'POST', json: { text: 'apa ini?', attachments: [png.id] } }));
    expect(img.body.message.content[0].text).toContain('(saw 1 image(s))');

    const conv2 = await newConversation({ profile: 'assistant' });
    const d = await json(
      await h.api(`/api/v1/conversations/${conv2.id}/messages`, { method: 'POST', json: { content: [{ type: 'text', text: 'baca [[doc]]' }, { type: 'file', file_id: doc.id }] } }),
    );
    expect(d.body.message.content[0].text).toContain('/data/attachments/notes.txt: first line of notes');

    const msgs = await json(await h.api(`/api/v1/conversations/${conv.id}/messages`));
    expect(msgs.body.data[0].content).toEqual([
      { type: 'text', text: 'apa ini?' },
      {
        type: 'image',
        file_id: png.id,
        mime_type: 'image/png',
        url: expect.stringContaining(`/media/${png.id}?`),
        thumbnail_url: expect.stringContaining('&variant=thumb'),
        preview_url: expect.stringContaining('&variant=preview'),
      },
    ]);

    const missing = await json(await h.api(`/api/v1/conversations/${conv.id}/messages`, { method: 'POST', json: { text: 'x', attachments: ['file_nope'] } }));
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('file_not_found');
  });

  it('archives the Qoder session when a conversation is deleted', async () => {
    const conv = await newConversation();
    expect((await h.api(`/api/v1/conversations/${conv.id}/messages`, { method: 'POST', json: { text: 'halo' } })).status).toBe(200);
    const sid = (await h.ctx.conversations.get(conv.id)).qoderSessionId!;
    expect(h.qoder.state.sessions.get(sid)!.archived_at).toBeNull();
    expect((await h.api(`/api/v1/conversations/${conv.id}`, { method: 'DELETE' })).status).toBe(204);
    await expect.poll(() => h.qoder.state.sessions.get(sid)!.archived_at).toBeTruthy();
  });

  it('mounts chat images into the sandbox for tool profiles so tools can use them as files', async () => {
    const png = await upload('wajah.png', makePng(), 'image/png');
    const mounted = () => [...h.qoder.state.sessions.values()].flatMap((s) => s.resources.map((r) => r.mount_path));

    const before = mounted().length;
    const chat = await newConversation();
    expect((await h.api(`/api/v1/conversations/${chat.id}/messages`, { method: 'POST', json: { text: 'lihat', attachments: [png.id] } })).status).toBe(200);
    expect(mounted().length).toBe(before);

    const conv = await newConversation({ profile: 'assistant' });
    const r = await json(await h.api(`/api/v1/conversations/${conv.id}/messages`, { method: 'POST', json: { text: 'tambahin orang ini', attachments: [png.id] } }));
    expect(r.status).toBe(200);
    expect(r.body.message.content[0].text).toContain('(saw 1 image(s))');
    expect(mounted()).toContain('/data/attachments/wajah.png');
  });

  it('rejects uploads over 50 MB and requests without a file', async () => {
    const big = new FormData();
    big.append('file', new Blob([new Uint8Array(51 * 1024 * 1024)]), 'big.bin');
    const res = await json(await h.api('/api/v1/files', { method: 'POST', body: big }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('file_too_large');
    const none = new FormData();
    none.append('other', 'x');
    expect((await h.api('/api/v1/files', { method: 'POST', body: none })).status).toBe(400);
  });

  it('returns assistant artifacts with signed URLs', async () => {
    const conv = await newConversation({ profile: 'assistant' });
    const r = await json(await h.api(`/api/v1/conversations/${conv.id}/messages`, { method: 'POST', json: { text: 'gambar [[image]]' } }));
    expect(r.body.message.artifacts).toHaveLength(1);
    const art = r.body.message.artifacts[0];
    expect(art).toMatchObject({ kind: 'image', mime_type: 'image/png' });
    expect((await fetch(art.url)).headers.get('content-type')).toBe('image/png');
  });
});

describe('admin, usage and limits', () => {
  it('lets admins manage users and sync models; others get 403', async () => {
    expect((await h.api('/api/v1/admin/users')).status).toBe(403);
    const created = await json(await h.api('/api/v1/admin/users', { method: 'POST', key: h.admin.apiKey, json: { email: 'new@test.local', password: 'new-password-1', monthly_credit_limit: 5 } }));
    expect(created.status).toBe(201);
    expect(created.body.user).toMatchObject({ email: 'new@test.local', role: 'user', monthly_credit_limit: 5 });
    const dup = await json(await h.api('/api/v1/admin/users', { method: 'POST', key: h.admin.apiKey, json: { email: 'new@test.local' } }));
    expect(dup.status).toBe(409);

    const list = await json(await h.api('/api/v1/admin/users', { key: h.admin.apiKey }));
    expect(list.body.data.map((u: any) => u.email)).toContain('new@test.local');

    const patched = await json(await h.api(`/api/v1/admin/users/${created.body.user.id}`, { method: 'PATCH', key: h.admin.apiKey, json: { role: 'admin', disabled: true } }));
    expect(patched.body.user).toMatchObject({ role: 'admin', disabled: true });
    await expect(h.ctx.auth.login('new@test.local', 'new-password-1')).rejects.toMatchObject({ status: 401 });

    h.qoder.addModel({ id: 'brandnew', display_name: 'Brand New' });
    const sync = await json(await h.api('/api/v1/admin/models/sync', { method: 'POST', key: h.admin.apiKey }));
    expect(sync.body.changes).toContainEqual({ type: 'model.added', model: { id: 'brandnew', display_name: 'Brand New' } });
    expect((await h.api('/api/v1/admin/models/sync', { method: 'POST' })).status).toBe(403);
  });

  it('reports usage and enforces the monthly credit limit', async () => {
    const usage = await json(await h.api('/api/v1/usage'));
    expect(usage.body.credits_used).toBeGreaterThan(0);
    expect(usage.body.by_kind.chat.requests).toBeGreaterThan(0);

    await h.api(`/api/v1/admin/users/${h.userId}`, { method: 'PATCH', key: h.admin.apiKey, json: { monthly_credit_limit: 0.001 } });
    const conv = await newConversation();
    const r = await json(await h.api(`/api/v1/conversations/${conv.id}/messages`, { method: 'POST', json: { text: 'x' } }));
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('credit_limit_exceeded');
    const img = await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'x' } }));
    expect(img.status).toBe(429);
    await h.api(`/api/v1/admin/users/${h.userId}`, { method: 'PATCH', key: h.admin.apiKey, json: { monthly_credit_limit: null } });
    expect((await h.api(`/api/v1/conversations/${conv.id}/messages`, { method: 'POST', json: { text: 'x' } })).status).toBe(200);
  });
});

describe('API key prefixes', () => {
  it('still accepts legacy qr_ keys issued before the StillGPT rename', async () => {
    const { apiKeys } = await import('../../src/db/schema.js');
    const { sha256 } = await import('../../src/ids.js');
    const legacy = 'qr_' + 'a'.repeat(40);
    await h.ctx.database.db.insert(apiKeys).values({ id: 'key_legacy', userId: h.userId, name: 'legacy', prefix: legacy.slice(0, 10), keyHash: sha256(legacy) });
    const me = await h.api('/api/v1/me', { key: legacy });
    expect(me.status).toBe(200);
    expect((await me.json()).user.id).toBe(h.userId);
  });
});
