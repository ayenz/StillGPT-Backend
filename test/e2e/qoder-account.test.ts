import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { files, kv, qoderAgents } from '../../src/db/schema.js';
import { drain, type Harness, startHarness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h?.close());

async function chat(t: string) {
  const conv = await h.ctx.conversations.create({ userId: h.userId, profile: 'chat', model: 'default' });
  const handle = await h.ctx.turns.start({ conversationId: conv.id, userId: h.userId, content: [{ type: 'text', text: t }] });
  await drain(handle.iterate());
  return handle.done;
}

const cachedEnv = async () => (await h.ctx.database.db.select().from(kv).where(eq(kv.key, 'qoder.environment_id')))[0]?.value;

describe('Qoder account changes', () => {
  it('re-resolves the environment when the cached one is gone upstream', async () => {
    expect((await chat('halo')).text).toContain('Echo');
    const before = await cachedEnv();
    expect(before).toBeTruthy();

    h.qoder.state.environments.clear(); // e.g. the PAT now points at another account
    expect((await chat('lagi')).text).toContain('Echo');
    const after = await cachedEnv();
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });

  it('drops cached environment and agents when the credential fingerprint changes', async () => {
    await chat('warm up');
    expect(await h.ctx.database.db.select().from(qoderAgents)).not.toHaveLength(0);

    await h.ctx.agents.syncAccount('same-fingerprint-twice');
    await chat('still works');
    await h.ctx.agents.syncAccount('same-fingerprint-twice');
    expect(await h.ctx.database.db.select().from(qoderAgents)).not.toHaveLength(0); // unchanged → kept

    await h.ctx.agents.syncAccount('another-account');
    expect(await h.ctx.database.db.select().from(qoderAgents)).toHaveLength(0);
    expect(await cachedEnv()).toBeUndefined();
    expect((await chat('after switch')).text).toContain('Echo');
  });

  it('re-uploads an attachment whose cached Qoder file is gone upstream', async () => {
    const file = await h.ctx.store.save({ userId: h.userId, kind: 'upload', filename: 'notes.txt', mimeType: 'text/plain', bytes: Buffer.from('hello') });
    const send = async () => {
      const conv = await h.ctx.conversations.create({ userId: h.userId, profile: 'chat', model: 'default' });
      const handle = await h.ctx.turns.start({
        conversationId: conv.id,
        userId: h.userId,
        content: [{ type: 'text', text: 'read it' }, { type: 'document', fileId: file.id, filename: 'notes.txt', mimeType: 'text/plain' }],
      });
      await drain(handle.iterate());
      return handle.done;
    };
    const qoderId = async () => (await h.ctx.database.db.select().from(files).where(eq(files.id, file.id)))[0]!.qoderFileId;

    expect((await send()).error).toBeFalsy();
    const first = await qoderId();
    expect(first).toBeTruthy();

    h.qoder.state.files.delete(first!); // e.g. uploaded under the previous PAT/account
    expect((await send()).error).toBeFalsy();
    const second = await qoderId();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it('forgets cached uploads when the credential fingerprint changes', async () => {
    const file = await h.ctx.store.save({ userId: h.userId, kind: 'upload', filename: 'a.txt', mimeType: 'text/plain', bytes: Buffer.from('a') });
    await h.ctx.store.setQoderFileId(file.id, 'file_old_account');
    await h.ctx.agents.syncAccount('yet-another-account');
    expect((await h.ctx.database.db.select().from(files).where(eq(files.id, file.id)))[0]!.qoderFileId).toBeNull();
  });
});
