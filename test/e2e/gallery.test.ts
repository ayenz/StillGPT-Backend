import { existsSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conversations, files, mediaJobs } from '../../src/db/schema.js';
import { makePng } from '../mock-qoder/index.js';
import { type Harness, startHarness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ mock: { videoDelayMs: 600 }, env: { MEDIA_POLL_INTERVAL_MS: '50' } });
});
afterAll(() => h?.close());

const json = async (res: Response) => ({ status: res.status, body: (await res.json().catch(() => null)) as any });
const db = () => h.ctx.database.db;
const admin = (path: string, init: RequestInit & { json?: unknown } = {}) => h.api(`/api/v1/admin${path}`, { ...init, key: h.admin.apiKey });
const image = async (prompt = 'gambar') => (await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt } }))).body;
const fileRow = async (id: string) => (await db().select().from(files).where(eq(files.id, id)))[0];
const jobRow = async (id: string) => (await db().select().from(mediaJobs).where(eq(mediaJobs.id, id)))[0];
const daysAgo = (d: number) => new Date(Date.now() - d * 86400_000);

async function upload(name = 'foto.png') {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(makePng())], { type: 'image/png' }), name);
  return (await (await h.api('/api/v1/files', { method: 'POST', body: form })).json()) as { id: string };
}

async function runHousekeeping(dryRun = false) {
  return (await json(await admin('/media-housekeeping/run', { method: 'POST', json: { dry_run: dryRun } }))).body.report;
}

describe('hidden jobs (gallery: false)', () => {
  it('stay out of the gallery list but are readable by id, also in a batch', async () => {
    const one = (await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'tersembunyi', gallery: false } }))).body;
    expect(one.status).toBe('completed');
    expect(one.request.hidden).toBe(true);
    const batch = (await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'massal', n: 2, gallery: false } }))).body;
    expect(batch.status).toBe('completed');
    const shown = await image('kelihatan');

    const listed = (await json(await h.api('/api/v1/jobs?kind=image&limit=100'))).body.data.map((j: any) => j.id);
    expect(listed).toContain(shown.id);
    expect(listed).not.toContain(one.id);
    for (const j of batch.jobs) expect(listed).not.toContain(j.id);

    expect((await json(await h.api(`/api/v1/jobs/${one.id}`))).body).toMatchObject({ id: one.id, status: 'completed' });
    expect((await json(await h.api(`/api/v1/images/batches/${batch.id}`))).body.jobs).toHaveLength(2);
    expect((await fetch(one.outputs[0].url)).status).toBe(200);
  });

  it('gallery must be a boolean', async () => {
    expect((await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'x', gallery: 'no' } })).status).toBe(400);
  });
});

describe('gallery trash (user)', () => {
  it('delete hides the job and its media at once; restore brings both back', async () => {
    const job = await image('dihapus');
    const url = job.outputs[0].url;
    expect((await fetch(url)).status).toBe(200);

    expect((await h.api(`/api/v1/jobs/${job.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await h.api(`/api/v1/jobs/${job.id}`)).status).toBe(404);
    expect((await json(await h.api('/api/v1/jobs?kind=image&limit=100'))).body.data.map((j: any) => j.id)).not.toContain(job.id);
    expect((await fetch(url)).status).toBe(404);
    expect((await fetch(`${url}&variant=thumb`)).status).toBe(404);
    expect(await jobRow(job.id)).toMatchObject({ deletedBy: 'user' });

    const restored = await json(await h.api(`/api/v1/jobs/${job.id}/restore`, { method: 'POST' }));
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ id: job.id, status: 'completed' });
    expect((await fetch(url)).status).toBe(200);
    expect((await h.api(`/api/v1/jobs/${job.id}/restore`, { method: 'POST' })).status).toBe(400); // not in the trash
  });

  it('a running job cannot be deleted', async () => {
    const vid = (await json(await h.api('/api/v1/videos', { method: 'POST', json: { prompt: 'ombak' } }))).body;
    const r = await json(await h.api(`/api/v1/jobs/${vid.id}`, { method: 'DELETE' }));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('job_running');
  });

  it('bulk delete reports what it skipped; other users’ jobs are untouchable', async () => {
    const a = await image('a');
    const b = await image('b');
    const theirs = (await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'punya admin' }, key: h.admin.apiKey }))).body;
    const r = await json(await h.api('/api/v1/jobs/delete', { method: 'POST', json: { ids: [a.id, b.id, theirs.id, 'img_nope'] } }));
    expect(r.body.trashed.sort()).toEqual([a.id, b.id].sort());
    expect(r.body.skipped).toEqual([
      { id: theirs.id, reason: 'not_found' },
      { id: 'img_nope', reason: 'not_found' },
    ]);
    expect((await h.api(`/api/v1/jobs/${theirs.id}`, { key: h.admin.apiKey })).status).toBe(200);
    expect((await h.api(`/api/v1/jobs/${theirs.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await h.api('/api/v1/jobs/delete', { method: 'POST', json: { ids: [] } })).status).toBe(400);
  });

  it('clear-failed trashes only failed jobs', async () => {
    const failed = await image('rusak [[error]]');
    const ok = await image('bagus');
    expect(failed.status).toBe('failed');
    const r = await json(await h.api('/api/v1/jobs/clear-failed', { method: 'POST' }));
    expect(r.body.trashed).toContain(failed.id);
    expect(r.body.trashed).not.toContain(ok.id);
    expect((await h.api(`/api/v1/jobs/${ok.id}`)).status).toBe(200);
  });

  it('deletes a whole batch', async () => {
    const batch = (await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'seri', n: 3 } }))).body;
    const r = await json(await h.api(`/api/v1/images/batches/${batch.id}`, { method: 'DELETE' }));
    expect(r.body.trashed).toHaveLength(3);
    expect((await h.api(`/api/v1/images/batches/${batch.id}`)).status).toBe(404);
    expect((await json(await h.api(`/api/v1/jobs?batch_id=${batch.id}`))).body.data).toEqual([]);
  });

  it('an image a live chat shows stays visible there while its job is in the trash', async () => {
    const job = await image('dipakai di chat');
    const fileId = job.outputs[0].id;
    const conv = (await json(await h.api('/api/v1/conversations', { method: 'POST', json: {} }))).body;
    expect((await h.api(`/api/v1/conversations/${conv.id}/messages`, { method: 'POST', json: { text: 'lihat', attachments: [fileId] } })).status).toBe(200);
    await h.api(`/api/v1/jobs/${job.id}`, { method: 'DELETE' });
    expect((await fileRow(fileId))!.deletedAt).toBeNull();
    expect((await fetch(job.outputs[0].url)).status).toBe(200);
  });
});

describe('gallery trash (admin)', () => {
  it('only admins see the trash, with owner, purge date and working thumbnails', async () => {
    const job = await image('untuk sampah');
    await h.api(`/api/v1/jobs/${job.id}`, { method: 'DELETE' });
    expect((await h.api('/api/v1/admin/trash')).status).toBe(403);

    const list = await json(await admin('/trash?kind=image&limit=200'));
    const item = list.body.data.find((t: any) => t.job.id === job.id);
    expect(item).toMatchObject({ user: { id: h.userId, email: 'user@test.local' }, deleted_by: 'user' });
    expect(Date.parse(item.purge_at) - Date.parse(item.deleted_at)).toBe(7 * 86400_000);
    expect(item.bytes).toBeGreaterThan(0);
    expect(item.job.outputs[0].thumbnail_url).toContain('scope=trash');
    expect((await fetch(item.job.outputs[0].thumbnail_url)).status).toBe(200);
    expect((await fetch(item.job.outputs[0].url)).status).toBe(200);
    // a user URL cannot be turned into a trash URL
    expect((await fetch(`${job.outputs[0].url}&scope=trash`)).status).toBe(403);
  });

  it('restore and purge', async () => {
    const keep = await image('pulihkan');
    const gone = await image('hapus permanen');
    await h.api('/api/v1/jobs/delete', { method: 'POST', json: { ids: [keep.id, gone.id] } });

    expect((await json(await admin('/trash/restore', { method: 'POST', json: { ids: [keep.id] } }))).body.restored).toEqual([keep.id]);
    expect((await h.api(`/api/v1/jobs/${keep.id}`)).status).toBe(200);

    const file = (await fileRow(gone.outputs[0].id))!;
    const path = h.ctx.store.pathOf(file);
    expect(existsSync(path)).toBe(true);
    const r = await json(await admin('/trash/purge', { method: 'POST', json: { ids: [gone.id] } }));
    expect(r.body.report).toMatchObject({ jobs_purged: 1, files_deleted: 1, files_in_use: 0 });
    expect(r.body.report.bytes_freed).toBeGreaterThan(0);
    expect(existsSync(path)).toBe(false);
    expect(await fileRow(file.id)).toBeUndefined();
    expect(await jobRow(gone.id)).toBeUndefined();
    const hidden = await db().select().from(conversations);
    expect(hidden.some((c) => (c.metadata as any).job_id === gone.id)).toBe(false);
    // purge only touches trashed jobs
    expect((await json(await admin('/trash/purge', { method: 'POST', json: { ids: [keep.id] } }))).body.report.jobs_purged).toBe(0);
  });
});

describe('media housekeeping', () => {
  it('has editable settings with the agreed defaults', async () => {
    const s = await json(await admin('/media-housekeeping'));
    expect(s.body).toMatchObject({
      source: 'default',
      settings: { enabled: true, trash_grace_days: 7, hide_failed_after_days: 7, archived_chat_media_days: 30, unused_upload_days: 30, retention_days: 0, interval_hours: 24 },
    });
    expect(s.body.storage.files).toBeGreaterThan(0);

    const p = await json(await admin('/media-housekeeping', { method: 'PATCH', json: { trash_grace_days: 14 } }));
    expect(p.body).toMatchObject({ source: 'admin', settings: { trash_grace_days: 14, archived_chat_media_days: 30 } });
    expect((await admin('/media-housekeeping', { method: 'PATCH', json: { trash_grace_days: -1 } })).status).toBe(400);
    expect((await admin('/media-housekeeping', { method: 'PATCH', json: { nope: 1 } })).status).toBe(400);
    expect((await h.api('/api/v1/admin/media-housekeeping')).status).toBe(403);
    await admin('/media-housekeeping', { method: 'PATCH', json: { trash_grace_days: 7 } });
  });

  it('purges trash past the grace period, old failed jobs, archived chat media and unused uploads', async () => {
    // trash past grace
    const old = await image('lama di sampah');
    await h.api(`/api/v1/jobs/${old.id}`, { method: 'DELETE' });
    await db().update(mediaJobs).set({ deletedAt: daysAgo(8) }).where(eq(mediaJobs.id, old.id));
    const fresh = await image('baru di sampah');
    await h.api(`/api/v1/jobs/${fresh.id}`, { method: 'DELETE' });
    // old failed job
    const failed = await image('gagal lama [[error]]');
    await db().update(mediaJobs).set({ createdAt: daysAgo(10) }).where(eq(mediaJobs.id, failed.id));
    // archived chat with an attachment
    const att = await upload('chat.png');
    const conv = (await json(await h.api('/api/v1/conversations', { method: 'POST', json: {} }))).body;
    await h.api(`/api/v1/conversations/${conv.id}/messages`, { method: 'POST', json: { text: 'ini', attachments: [att.id] } });
    await h.api(`/api/v1/conversations/${conv.id}`, { method: 'DELETE' });
    await db().update(conversations).set({ archivedAt: daysAgo(31) }).where(eq(conversations.id, conv.id));
    // unused vs. used old uploads
    const unused = await upload('nganggur.png');
    const used = await upload('dipakai.png');
    const live = (await json(await h.api('/api/v1/conversations', { method: 'POST', json: {} }))).body;
    await h.api(`/api/v1/conversations/${live.id}/messages`, { method: 'POST', json: { text: 'pakai', attachments: [used.id] } });
    await db().update(files).set({ createdAt: daysAgo(40) }).where(eq(files.id, unused.id));
    await db().update(files).set({ createdAt: daysAgo(40) }).where(eq(files.id, used.id));

    const before = { old: await jobRow(old.id), att: await fileRow(att.id), unused: await fileRow(unused.id) };
    const dry = await runHousekeeping(true);
    expect(dry.dry_run).toBe(true);
    expect(dry.jobs_purged).toBeGreaterThanOrEqual(1);
    expect(await jobRow(old.id)).toEqual(before.old); // dry run changed nothing
    expect(await fileRow(unused.id)).toEqual(before.unused);

    const report = await runHousekeeping();
    expect(report.jobs_purged).toBeGreaterThanOrEqual(1);
    expect(report.jobs_trashed).toBeGreaterThanOrEqual(1);
    expect(await jobRow(old.id)).toBeUndefined();
    expect(await fileRow(old.outputs[0].id)).toBeUndefined();
    expect(await jobRow(fresh.id)).toMatchObject({ deletedBy: 'user' }); // still within grace
    expect(await jobRow(failed.id)).toMatchObject({ deletedBy: 'system' });
    expect(await fileRow(att.id)).toBeUndefined();
    expect(existsSync(h.ctx.store.pathOf(before.att!))).toBe(false);
    expect(await fileRow(unused.id)).toBeUndefined();
    expect(await fileRow(used.id)).toBeDefined();

    const status = await json(await admin('/media-housekeeping'));
    expect(status.body.last_run).toMatchObject({ trigger: 'manual', report: { jobs_purged: report.jobs_purged } });
  });

  it('keeps a trashed output that another job still uses as input, and sweeps it once that job is gone', async () => {
    const src = await image('sumber');
    const srcFile = src.outputs[0].id;
    const edit = await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'edit', input_file_ids: [srcFile] } }));
    expect(edit.body.status).toBe('completed');
    await h.api(`/api/v1/jobs/${src.id}`, { method: 'DELETE' });
    const purged = await json(await admin('/trash/purge', { method: 'POST', json: { ids: [src.id] } }));
    expect(purged.body.report).toMatchObject({ jobs_purged: 1, files_in_use: 1, files_deleted: 0 });
    expect((await fileRow(srcFile))!.deletedAt).not.toBeNull();

    await h.api(`/api/v1/jobs/${edit.body.id}`, { method: 'DELETE' });
    await admin('/trash/purge', { method: 'POST', json: { ids: [edit.body.id] } });
    await db().update(files).set({ deletedAt: daysAgo(8) }).where(eq(files.id, srcFile));
    await runHousekeeping();
    expect(await fileRow(srcFile)).toBeUndefined();
  });

  it('retention trashes old finished jobs only when enabled', async () => {
    const job = await image('arsip lama');
    await db().update(mediaJobs).set({ createdAt: daysAgo(100) }).where(eq(mediaJobs.id, job.id));
    await runHousekeeping();
    expect((await jobRow(job.id))!.deletedAt).toBeNull();
    await admin('/media-housekeeping', { method: 'PATCH', json: { retention_days: 90 } });
    await runHousekeeping();
    expect(await jobRow(job.id)).toMatchObject({ deletedBy: 'system' });
    await admin('/media-housekeeping', { method: 'PATCH', json: { retention_days: 0 } });
  });
});
