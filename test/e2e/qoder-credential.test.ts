import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conversations, kv, qoderAgents } from '../../src/db/schema.js';
import { drain, type Harness, startHarness } from './harness.js';

async function chat(h: Harness, t: string) {
  const conv = await h.ctx.conversations.create({ userId: h.userId, profile: 'chat', model: 'default' });
  const handle = await h.ctx.turns.start({ conversationId: conv.id, userId: h.userId, content: [{ type: 'text', text: t }] });
  await drain(handle.iterate());
  return handle.done;
}

const NEW_PAT = 'pt-other-account-0001';

describe('admin Qoder credential (PAT)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(() => h?.close());

  const admin = (init: RequestInit & { json?: unknown; query?: string } = {}) =>
    h.api(`/api/v1/admin/qoder/credential${init.query ?? ''}`, { ...init, key: h.admin.apiKey });

  it('is admin-only and never returns the token', async () => {
    expect((await h.api('/api/v1/admin/qoder/credential')).status).toBe(403);
    const res = await admin();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('pt-test');
    expect(JSON.parse(text)).toEqual({
      mode: 'pat',
      source: 'env',
      last4: 'test',
      updated_at: null,
      environment_pinned: false,
      busy: { conversations: 0, media_jobs: 0 },
    });
  });

  it('rejects a PAT Qoder does not accept and keeps the old one', async () => {
    const res = await admin({ method: 'PUT', json: { pat: 'pt-wrong-wrong' } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe('invalid_qoder_pat');
    expect((await admin({ method: 'PUT', json: { pat: 'x' } })).status).toBe(400);
    expect((await chat(h, 'masih jalan')).text).toContain('Echo');
  });

  it('refuses while a conversation is busy unless force', async () => {
    const conv = await h.ctx.conversations.create({ userId: h.userId, profile: 'chat', model: 'default' });
    await h.ctx.database.db.update(conversations).set({ status: 'busy' }).where(eq(conversations.id, conv.id));
    try {
      const res = await admin({ method: 'PUT', json: { pat: 'pt-test' } });
      expect(res.status).toBe(409);
      const err = ((await res.json()) as any).error;
      expect(err.code).toBe('qoder_busy');
      expect(err.details).toEqual({ busy_conversations: 1, busy_media_jobs: 0 });
      expect(((await (await admin()).json()) as any).busy.conversations).toBe(1);
    } finally {
      await h.ctx.database.db.update(conversations).set({ status: 'idle' }).where(eq(conversations.id, conv.id));
    }
  });

  it('switches to a new PAT live: resets account-bound caches and keeps working', async () => {
    await chat(h, 'warm up');
    expect(await h.ctx.database.db.select().from(qoderAgents)).not.toHaveLength(0);

    h.qoder.setToken(NEW_PAT); // the old PAT stops working upstream
    h.qoder.state.environments.clear(); // and the new account has none of our ids
    const res = await admin({ method: 'PUT', json: { pat: NEW_PAT } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ mode: 'pat', source: 'admin', last4: '0001', account_changed: true });
    expect(body.updated_at).toBeTruthy();
    expect(await h.ctx.database.db.select().from(qoderAgents)).toHaveLength(0);

    expect((await chat(h, 'akun baru')).text).toContain('Echo');

    // same PAT again → nothing to reset
    const again = (await (await admin({ method: 'PUT', json: { pat: NEW_PAT } })).json()) as any;
    expect(again.account_changed).toBe(false);
    expect(await h.ctx.database.db.select().from(qoderAgents)).not.toHaveLength(0);
  });

  it('is stored in kv, and DELETE falls back to QODER_PAT', async () => {
    const [row] = await h.ctx.database.db.select().from(kv).where(eq(kv.key, 'qoder.pat'));
    expect((row?.value as any).pat).toBe(NEW_PAT);

    // QODER_PAT no longer works upstream → falling back is refused by the check
    const refused = await admin({ method: 'DELETE' });
    expect(refused.status).toBe(400);

    h.qoder.setToken('pt-test');
    const res = await admin({ method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toMatchObject({ source: 'env', last4: 'test', account_changed: true });
    expect((await chat(h, 'balik ke env')).text).toContain('Echo');
  });
});

describe('admin Qoder credential without QODER_PAT', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ env: { QODER_PAT: '' } });
  });
  afterAll(() => h?.close());

  it('starts unconfigured, then works once an admin sets a PAT', async () => {
    const admin = (init: RequestInit & { json?: unknown } = {}) => h.api('/api/v1/admin/qoder/credential', { ...init, key: h.admin.apiKey });
    expect(((await (await admin()).json()) as any)).toMatchObject({ mode: 'none', source: null, last4: null });
    expect((await chat(h, 'halo')).error).toMatchObject({ code: 'qoder_not_configured' });

    // nothing to fall back to
    expect((await admin({ method: 'DELETE' })).status).toBe(200);

    const res = await admin({ method: 'PUT', json: { pat: 'pt-test' } });
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toMatchObject({ mode: 'pat', source: 'admin', account_changed: true });
    expect((await chat(h, 'halo')).text).toContain('Echo');

    const del = await admin({ method: 'DELETE' });
    expect(del.status).toBe(409);
    expect(((await del.json()) as any).error.code).toBe('qoder_pat_required');
  });
});
