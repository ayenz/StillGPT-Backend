import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conversations, files } from '../../src/db/schema.js';
import { makePng } from '../mock-qoder/index.js';
import { type Harness, startHarness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ env: { QODER_HOUSEKEEPING_INTERVAL_HOURS: '0' } });
});
afterAll(() => h?.close());

const DAY = 24 * 3600_000;

async function send(convId: string, body: Record<string, unknown>) {
  const res = await h.api(`/api/v1/conversations/${convId}/messages`, { method: 'POST', json: body });
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

describe('qoder housekeeping', () => {
  it('archives idle sessions, deletes their Qoder files, and conversations keep working', async () => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(makePng())], { type: 'image/png' }), 'foto.png');
    const upload = (await (await h.api('/api/v1/files', { method: 'POST', body: form })).json()) as { id: string };

    const conv = (await (await h.api('/api/v1/conversations', { method: 'POST', json: { profile: 'assistant' } })).json()) as { id: string };
    await send(conv.id, { text: 'lihat ini', attachments: [upload.id] });
    await send(conv.id, { text: 'gambar kucing [[image]]' });

    const row = async () => (await h.ctx.database.db.select().from(conversations).where(eq(conversations.id, conv.id)))[0]!;
    const qid = async () => (await h.ctx.database.db.select().from(files).where(eq(files.id, upload.id)))[0]!.qoderFileId;
    const sessionId = (await row()).qoderSessionId!;
    const uploadedId = (await qid())!;
    expect(sessionId).toBeTruthy();
    expect(h.qoder.state.files.has(uploadedId)).toBe(true);
    const sessionFiles = () => [...h.qoder.state.files.values()].filter((f) => f.scope?.id === sessionId);
    expect(sessionFiles().length).toBeGreaterThan(0);

    // Fresh: nothing touched.
    const none = await h.ctx.housekeeper.run();
    expect(none).toMatchObject({ sessionsArchived: 0, filesDeleted: 0 });

    // A day later: session archived, its files and our upload deleted upstream, local ids cleared.
    const report = await h.ctx.housekeeper.run(new Date(Date.now() + DAY + 60_000));
    expect(report.sessionsArchived).toBeGreaterThanOrEqual(1);
    expect(report.errors).toBe(0);
    expect(h.qoder.state.sessions.get(sessionId)?.status).toBe('terminated');
    expect(h.qoder.state.files.has(uploadedId)).toBe(false);
    expect(sessionFiles()).toHaveLength(0);
    expect(await qid()).toBeNull();
    expect((await row()).qoderSessionId).toBeNull();

    // The conversation continues on a new session and the image is re-uploaded on demand.
    const again = await send(conv.id, { text: 'lagi', attachments: [upload.id] });
    expect(again.message.content[0].text).toContain('(saw 1 image(s))');
    const newSession = (await row()).qoderSessionId!;
    expect(newSession).not.toBe(sessionId);
    const reuploaded = (await qid())!;
    expect(reuploaded).not.toBe(uploadedId);
    expect(h.qoder.state.sessions.get(newSession)!.resources.map((r) => r.file_id)).toContain(reuploaded);
  });

  it('skips files still mounted by a live session and recovers a conversation whose session was archived elsewhere', async () => {
    const conv = (await (await h.api('/api/v1/conversations', { method: 'POST', json: { profile: 'assistant' } })).json()) as { id: string };
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(makePng())], { type: 'image/png' }), 'live.png');
    const upload = (await (await h.api('/api/v1/files', { method: 'POST', body: form })).json()) as { id: string };
    await send(conv.id, { text: 'simpan', attachments: [upload.id] });
    const [c] = await h.ctx.database.db.select().from(conversations).where(eq(conversations.id, conv.id));
    const [f] = await h.ctx.database.db.select().from(files).where(eq(files.id, upload.id));

    // The file is old but its session was just used → session kept, file reported in use.
    h.qoder.state.files.get(f!.qoderFileId!)!.created_at = new Date(Date.now() - 2 * DAY).toISOString();
    const report = await h.ctx.housekeeper.run();
    expect(report.filesInUse).toBe(1);
    expect(h.qoder.state.files.has(f!.qoderFileId!)).toBe(true);

    // Archived outside housekeeping (DB still points at it) → next turn opens a new session.
    h.qoder.state.sessions.get(c!.qoderSessionId!)!.archived_at = new Date().toISOString();
    h.qoder.state.sessions.get(c!.qoderSessionId!)!.status = 'terminated';
    await send(conv.id, { text: 'halo lagi' });
    const [after] = await h.ctx.database.db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(after!.qoderSessionId).not.toBe(c!.qoderSessionId);
  });
});
