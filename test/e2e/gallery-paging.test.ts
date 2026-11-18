import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeJobCursor } from '../../src/core/media.js';
import { type Harness, startHarness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h?.close());

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });

let seq = 0;
/** Inserts a finished job with an exact (microsecond) created_at. */
async function job(o: { userId?: string; kind?: 'image' | 'video'; status?: string; at: string; batch?: string; deleted?: boolean }) {
  const id = `img_page${String(seq++).padStart(4, '0')}`;
  await h.ctx.database.db.execute(sql`
    insert into media_jobs (id, user_id, kind, status, request, created_at, batch_id, deleted_at)
    values (${id}, ${o.userId ?? h.userId}, ${o.kind ?? 'image'}, ${o.status ?? 'completed'}, ${JSON.stringify({ prompt: id })}::jsonb,
            ${o.at}::timestamptz, ${o.batch ?? null}, ${o.deleted ? sql`now()` : null})`);
  return id;
}

/** Walks every page; returns the ids in order and the number of requests. */
async function walk(query: string, limit: number) {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const r = await json(await h.api(`/api/v1/jobs?limit=${limit}${query}${cursor ? `&cursor=${cursor}` : ''}`));
    expect(r.status).toBe(200);
    pages++;
    ids.push(...r.body.data.map((j: any) => j.id));
    expect(r.body.has_more).toBe(r.body.next_cursor !== null);
    cursor = r.body.next_cursor;
    if (pages > 100) throw new Error('runaway paging');
  } while (cursor);
  return { ids, pages };
}

describe('GET /jobs paging (gallery)', () => {
  const all: string[] = []; // newest first
  beforeAll(async () => {
    // 3 batches of 10 jobs that share one created_at each, 15 singles a few µs apart, 1 job in the trash, 1 of another user
    for (let b = 0; b < 3; b++) {
      const at = `2026-10-0${b + 1}T10:00:00.123456Z`;
      const batch: string[] = [];
      for (let i = 0; i < 10; i++) batch.push(await job({ at, batch: `batch_p${b}` }));
      all.unshift(...batch.sort().reverse()); // same created_at → id descending
    }
    for (let i = 0; i < 15; i++) all.unshift(await job({ at: `2026-10-05T10:00:00.1234${String(10 + i)}Z`, kind: i % 3 === 0 ? 'video' : 'image', status: i % 5 === 0 ? 'failed' : 'completed' }));
    await job({ at: '2026-10-06T00:00:00Z', deleted: true });
    const other = await h.ctx.auth.createUser({ email: 'other-gallery@test.local', password: 'password-123' });
    await job({ at: '2026-10-06T00:00:00Z', userId: other.id });
  });

  it('pages through everything exactly once, newest first, across batch ties and µs gaps', async () => {
    for (const limit of [1, 7, 20, 100]) {
      const { ids, pages } = await walk('', limit);
      expect(ids).toEqual(all);
      expect(pages).toBe(Math.ceil(all.length / limit)); // no trailing empty page
    }
  });

  it('first page keeps the old shape plus next_cursor / has_more', async () => {
    const r = await json(await h.api('/api/v1/jobs'));
    expect(r.body.data).toHaveLength(20); // default limit
    expect(r.body).toMatchObject({ has_more: true, next_cursor: expect.any(String) });
    const last = await json(await h.api('/api/v1/jobs?limit=100'));
    expect(last.body).toMatchObject({ has_more: false, next_cursor: null });
    expect(last.body.data).toHaveLength(all.length);
  });

  it('a job created while scrolling does not shift or repeat the next pages', async () => {
    const first = await json(await h.api('/api/v1/jobs?limit=10'));
    const fresh = await job({ at: '2026-11-01T00:00:00Z' });
    const ids: string[] = first.body.data.map((j: any) => j.id);
    let cursor = first.body.next_cursor;
    while (cursor) {
      const r = await json(await h.api(`/api/v1/jobs?limit=10&cursor=${cursor}`));
      ids.push(...r.body.data.map((j: any) => j.id));
      cursor = r.body.next_cursor;
    }
    try {
      expect(ids).toEqual(all);
      expect(ids).not.toContain(fresh);
      expect((await walk('', 10)).ids[0]).toBe(fresh); // a fresh walk from the top sees it first
    } finally {
      await h.ctx.database.db.execute(sql`delete from media_jobs where id = ${fresh}`);
    }
  });

  it('filters combine with paging: kind, status, batch_id', async () => {
    const videos = await walk('&kind=video', 2);
    expect(videos.ids.length).toBe(5);
    const failed = await walk('&status=failed', 2);
    expect(failed.ids.length).toBe(3);
    const done = await walk('&status=completed,queued&kind=image', 4);
    expect(done.ids.length).toBe(all.length - 5 - 2); // minus videos, minus failed images
    const batch = await walk('&batch_id=batch_p1', 3);
    expect(batch.ids).toEqual(all.filter((id) => all.indexOf(id) >= 15 + 10 && all.indexOf(id) < 15 + 20));
  });

  it('rejects a bad cursor or status', async () => {
    expect((await json(await h.api('/api/v1/jobs?cursor=nonsense'))).body.error.code).toBe('invalid_cursor');
    expect((await json(await h.api(`/api/v1/jobs?cursor=${encodeJobCursor('12', 'x y')}`))).status).toBe(400);
    expect((await json(await h.api('/api/v1/jobs?status=done'))).body.error.code).toBe('validation_error');
  });
});
