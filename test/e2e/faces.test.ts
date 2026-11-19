import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyCounts } from '../../src/core/trash.js';
import { closestImageSize, FACE_SWAP_PROMPT } from '../../src/core/media.js';
import { mediaJobs } from '../../src/db/schema.js';
import { makePng } from '../mock-qoder/index.js';
import { type Harness, startHarness } from './harness.js';
import { readSse } from './native-sse.js';

let h: Harness;
let otherKey: string;
beforeAll(async () => {
  h = await startHarness({ env: { MEDIA_POLL_INTERVAL_MS: '50' } });
  const other = await h.ctx.auth.createUser({ email: 'other@test.local', password: 'other-password-123' });
  otherKey = (await h.ctx.auth.createApiKey(other.id, 'test')).key;
});
afterAll(() => h?.close());

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });

async function upload(filename: string, bytes: Buffer | string, type: string, key?: string) {
  const form = new FormData();
  form.append('file', new Blob([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)], { type }), filename);
  return (await (await h.api('/api/v1/files', { method: 'POST', body: form, key })).json()) as { id: string };
}

const createFace = (payload: unknown, key?: string) => h.api('/api/v1/faces', { method: 'POST', json: payload, key });

describe('closestImageSize', () => {
  it('picks the allowed size with the nearest aspect ratio', () => {
    expect(closestImageSize(1000, 1000)).toBe('1024x1024');
    expect(closestImageSize(3000, 2000)).toBe('1536x1024');
    expect(closestImageSize(2000, 3000)).toBe('1024x1536');
    expect(closestImageSize(1080, 1920)).toBe('1024x1792');
    expect(closestImageSize(1080, 1350)).toBe('1024x1280');
    expect(closestImageSize(3000, 2250)).toBe('1024x768');
    expect(closestImageSize(2560, 1080)).toBe('2560x1080');
    expect(closestImageSize(undefined, 10)).toBe('1024x1024');
  });
});

describe('faces (native)', () => {
  it('create, list newest first, rename, delete', async () => {
    const a = await upload('a.png', makePng(), 'image/png');
    const b = await upload('b.png', makePng(3, 3), 'image/png');
    const r1 = await json(await createFace({ name: '  Budi ', file_id: a.id }));
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({ name: 'Budi', file_id: a.id, file: { id: a.id, mime_type: 'image/png' } });
    expect(r1.body.id).toMatch(/^face_/);
    expect(r1.body.file.url).toContain('/media/');
    expect(typeof r1.body.created_at).toBe('string');
    const r2 = await json(await createFace({ name: 'Sari', file_id: b.id }));

    const list = await json(await h.api('/api/v1/faces'));
    expect(list.body.data.map((f: any) => f.id).slice(0, 2)).toEqual([r2.body.id, r1.body.id]);

    const renamed = await json(await h.api(`/api/v1/faces/${r1.body.id}`, { method: 'PATCH', json: { name: 'Budi 2' } }));
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ id: r1.body.id, name: 'Budi 2', file_id: a.id });

    expect((await h.api(`/api/v1/faces/${r2.body.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await h.api(`/api/v1/faces/${r2.body.id}`, { method: 'DELETE' })).status).toBe(404);
    // the file stays
    expect((await h.api(`/api/v1/files/${b.id}`)).status).toBe(200);
  });

  it('validates name and file, scopes everything to the user', async () => {
    const png = await upload('x.png', makePng(), 'image/png');
    const doc = await upload('a.txt', 'hello', 'text/plain');
    const gif = await upload('a.gif', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'binary'), 'image/gif');
    expect((await json(await createFace({ name: '', file_id: png.id }))).status).toBe(400);
    expect((await json(await createFace({ name: 'x'.repeat(61), file_id: png.id }))).status).toBe(400);
    expect((await json(await createFace({ name: 'ok' }))).status).toBe(400);
    expect((await json(await createFace({ name: 'ok', file_id: doc.id }))).status).toBe(400);
    expect((await json(await createFace({ name: 'ok', file_id: gif.id }))).status).toBe(400);
    expect((await json(await createFace({ name: 'ok', file_id: 'file_missing' }))).body.error.code).toBe('file_not_found');

    // someone else's file / face
    expect((await json(await createFace({ name: 'ok', file_id: png.id }, otherKey))).status).toBe(404);
    const mine = await json(await createFace({ name: 'mine', file_id: png.id }));
    expect((await json(await h.api('/api/v1/faces', { key: otherKey }))).body.data).toEqual([]);
    expect((await h.api(`/api/v1/faces/${mine.body.id}`, { method: 'PATCH', json: { name: 'x' }, key: otherKey })).status).toBe(404);
    expect((await h.api(`/api/v1/faces/${mine.body.id}`, { method: 'DELETE', key: otherKey })).status).toBe(404);
    expect((await h.api(`/api/v1/faces/${mine.body.id}`, { method: 'PATCH', json: { name: ' ' } })).status).toBe(400);
  });

  it('keeps a face image through housekeeping of unused uploads', async () => {
    const f = await upload('keep.png', makePng(), 'image/png');
    await json(await createFace({ name: 'keep', file_id: f.id }));
    const counts = emptyCounts();
    await h.ctx.trash.removeUnused([await h.ctx.store.get(f.id)], { chats: 'all', counts });
    expect(counts).toMatchObject({ filesInUse: 1, filesDeleted: 0 });
  });
});

describe('face swap (native)', () => {
  it('202 with an async Qoder edit batch: target + face, fixed prompt, size from the target', async () => {
    const target = await upload('target.png', makePng(30, 20), 'image/png');
    const faceFile = await upload('face.png', makePng(4, 4), 'image/png');
    const face = (await json(await createFace({ name: 'Andi', file_id: faceFile.id }))).body;

    const r = await json(await h.api(`/api/v1/images/${target.id}/face-swap`, { method: 'POST', json: { face_id: face.id, n: 2 } }));
    expect(r.status).toBe(202);
    expect(r.body.id).toMatch(/^batch_/);
    expect(r.body.n).toBe(2);
    for (const [i, j] of r.body.jobs.entries()) {
      expect(j.request).toMatchObject({
        prompt: FACE_SWAP_PROMPT,
        size: '1536x1024',
        enhance: false,
        input_file_ids: [target.id, faceFile.id],
        provider: 'qoder',
        provider_used: 'qoder',
        n: 2,
        batch_index: i,
        face_swap: { source_file_id: target.id, face_id: face.id, face_name: 'Andi' },
      });
      expect(j.request).not.toHaveProperty('variation');
    }

    const events = await readSse(await h.api(`/api/v1/images/batches/${r.body.id}/events`));
    expect(events.at(-1)!.data).toMatchObject({ status: 'completed', completed: 2 });

    // the gallery shows it
    const listed = await json(await h.api(`/api/v1/jobs?batch_id=${r.body.id}`));
    expect(listed.body.data[0].request.face_swap).toEqual({ source_file_id: target.id, face_id: face.id, face_name: 'Andi' });

    const [row] = await h.ctx.database.db.select().from(mediaJobs).where(eq(mediaJobs.id, r.body.jobs[0].id));
    const s = h.qoder.state.sessions.get(row!.qoderSessionId!)!;
    expect(s.resources.map((x) => x.mount_path)).toEqual(['/data/attachments/target.png', '/data/attachments/face.png']);

    // deleting the face keeps past results
    expect((await h.api(`/api/v1/faces/${face.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await json(await h.api(`/api/v1/images/batches/${r.body.id}`))).body.jobs).toHaveLength(2);
  });

  it('defaults n to 1; 404 for a missing face or someone else’s target; 400 for bad n or a non-image target', async () => {
    const target = await upload('t.png', makePng(20, 30), 'image/png');
    const faceFile = await upload('f.png', makePng(), 'image/png');
    const face = (await json(await createFace({ name: 'Rina', file_id: faceFile.id }))).body;
    const swap = (fileId: string, payload: unknown, key?: string) => h.api(`/api/v1/images/${fileId}/face-swap`, { method: 'POST', json: payload, key });

    const one = await json(await swap(target.id, { face_id: face.id }));
    expect(one.status).toBe(202);
    expect(one.body.n).toBe(1);
    expect(one.body.jobs[0].request.size).toBe('1024x1536');

    expect((await json(await swap(target.id, { face_id: 'face_missing' }))).body.error.code).toBe('face_not_found');
    expect((await json(await swap(target.id, { face_id: face.id }, otherKey))).status).toBe(404);
    const otherTarget = await upload('o.png', makePng(), 'image/png', otherKey);
    expect((await json(await swap(otherTarget.id, { face_id: face.id }))).body.error.code).toBe('file_not_found');
    expect((await json(await swap(target.id, { face_id: face.id, n: 5 }))).status).toBe(400);
    expect((await json(await swap(target.id, { face_id: face.id, n: 0 }))).status).toBe(400);
    expect((await json(await swap(target.id, {}))).status).toBe(400);
    const doc = await upload('d.txt', 'hi', 'text/plain');
    expect((await json(await swap(doc.id, { face_id: face.id }))).status).toBe(400);
    await readSse(await h.api(`/api/v1/images/batches/${one.body.id}/events`)); // let the job finish before teardown
  });
});
