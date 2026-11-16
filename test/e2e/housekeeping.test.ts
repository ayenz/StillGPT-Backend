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

    // A dry run a day later reports the work but changes nothing.
    const later = new Date(Date.now() + DAY + 60_000);
    const preview = await h.ctx.housekeeper.run({ now: later, dryRun: true });
    expect(preview).toMatchObject({ dryRun: true, errors: 0 });
    expect(preview.sessionsArchived).toBeGreaterThanOrEqual(1);
    expect(preview.filesDeleted).toBeGreaterThanOrEqual(2);
    expect(h.qoder.state.sessions.get(sessionId)?.status).not.toBe('terminated');
    expect(h.qoder.state.files.has(uploadedId)).toBe(true);
    expect((await row()).qoderSessionId).toBe(sessionId);

    // The real pass: session archived, its files and our upload deleted upstream, local ids cleared.
    const report = await h.ctx.housekeeper.run({ now: later });
    expect(report).toMatchObject({ dryRun: false, sessionsArchived: preview.sessionsArchived, filesDeleted: preview.filesDeleted });
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

  it('lets admins read and change the settings, preview, run now, and the scheduler honours them', async () => {
    const admin = (path: string, init: RequestInit & { json?: unknown } = {}) => h.api(`/api/v1/admin/housekeeping${path}`, { ...init, key: h.admin.apiKey });
    expect((await h.api('/api/v1/admin/housekeeping')).status).toBe(403);

    // Env defaults (interval 0 in this harness → disabled) until an admin saves.
    const initial = (await (await admin('')).json()) as any;
    expect(initial).toMatchObject({ source: 'env', settings: { enabled: false, retention_hours: 24, interval_hours: 24 }, next_run_at: null });

    expect((await admin('', { method: 'PATCH', json: { retention_hours: 0 } })).status).toBe(400);
    expect((await admin('', { method: 'PATCH', json: { retention_hours: 24 * 366 } })).status).toBe(400);
    expect((await admin('', { method: 'PATCH', json: { nope: 1 } })).status).toBe(400);

    const saved = (await (await admin('', { method: 'PATCH', json: { enabled: true, retention_hours: 24 * 30 } })).json()) as any;
    expect(saved).toMatchObject({ source: 'admin', settings: { enabled: true, retention_hours: 720, interval_hours: 24 } });
    expect(saved.next_run_at).toBeTruthy();
    // Partial updates keep the other fields.
    const weekly = (await (await admin('', { method: 'PATCH', json: { interval_hours: 168 } })).json()) as any;
    expect(weekly.settings).toEqual({ enabled: true, retention_hours: 720, interval_hours: 168 });

    // Dry run (no body fields needed) is not recorded as the last run.
    const before = (await (await admin('')).json()) as any;
    const dry = (await (await admin('/run', { method: 'POST', json: { dry_run: true, retention_hours: 1 } })).json()) as any;
    expect(dry.report).toMatchObject({ dry_run: true, errors: 0 });
    expect(dry.last_run).toEqual(before.last_run);

    // Run now with an empty body → recorded with the saved 30-day retention.
    const now = (await (await admin('/run', { method: 'POST' })).json()) as any;
    expect(now.report.dry_run).toBe(false);
    expect(now.last_run).toMatchObject({ trigger: 'manual', retention_hours: 720, error: null });
    expect(now.last_run.report).toEqual(now.report);

    // Scheduler: not due right after a run; due once the interval has passed.
    await h.ctx.housekeeper.tick();
    expect(((await (await admin('')).json()) as any).last_run.at).toBe(now.last_run.at);
    await h.ctx.housekeeper.tick(new Date(Date.now() + 169 * 3600_000));
    const scheduled = ((await (await admin('')).json()) as any).last_run;
    expect(scheduled.trigger).toBe('schedule');

    // Disabled → the scheduler never runs.
    await admin('', { method: 'PATCH', json: { enabled: false } });
    await h.ctx.housekeeper.tick(new Date(Date.now() + 1000 * 3600_000));
    expect(((await (await admin('')).json()) as any).last_run.at).toBe(scheduled.at);
    expect(((await (await admin('')).json()) as any).next_run_at).toBeNull();
  });
});
