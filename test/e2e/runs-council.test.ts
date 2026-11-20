import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { aggregate, judgeQuality, parseDebate } from '../../src/core/runs/council.js';
import { extractJson } from '../../src/core/runs/json.js';
import { Semaphore } from '../../src/core/runs/semaphore.js';
import { conversations, runSteps, runs } from '../../src/db/schema.js';
import { type Harness, startHarness } from './harness.js';
import { readSse } from './native-sse.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ env: { RUN_RETRY_BASE_MS: '5', COUNCIL_JUDGES: 'ultimate,efficient', COUNCIL_SYNTHESIZER: 'ultimate' } });
});
afterEach(() => h.qoder.setReply(undefined));
afterAll(() => h?.close());

const json = async (res: Response) => (await res.json()) as any;
const isJudge = (t: string) => t.startsWith('You are a strict, impartial judge');
const isSynth = (t: string) => t.startsWith('Several AI models answered');
const isDebate = (t: string) => t.startsWith('You answered a question together');

/** Judge reply that ranks the answer written by `bestModel` first (answers are the mock's `[model] Echo …` texts). */
function judgeRanking(t: string, bestModel: string): string {
  const ids = [...t.matchAll(/<answer id="([A-Z]+)">\n([^\n]*)/g)].map((m) => ({ id: m[1]!, best: m[2]!.includes(`[${bestModel}]`) }));
  const ranking = [...ids].sort((a, b) => Number(b.best) - Number(a.best)).map((x) => x.id);
  return JSON.stringify({
    category: 'coding',
    scores: ids.map((x) => ({ id: x.id, correctness: x.best ? 9 : 5, completeness: 7, clarity: 7, total: x.best ? 9 : 5 })),
    ranking,
    best_parts: [{ id: ranking[0], note: 'clear example' }],
  });
}

async function waitRun(id: string, until = (r: any) => ['completed', 'failed', 'cancelled', 'awaiting_input'].includes(r.status)) {
  for (let i = 0; i < 400; i++) {
    const r = await json(await h.api(`/api/v1/runs/${id}`));
    if (until(r)) return r;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`run ${id} did not settle`);
}

describe('helpers', () => {
  it('extracts JSON from chatty or fenced replies', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here it is: {"a": [1, 2]} hope it helps')).toEqual({ a: [1, 2] });
    expect(extractJson('no json here')).toBeUndefined();
  });

  it('limits holders and serves waiters in order', async () => {
    const s = new Semaphore(2);
    const order: number[] = [];
    const r1 = await s.acquire();
    const r2 = await s.acquire();
    const p3 = s.acquire().then((r) => (order.push(3), r));
    const p4 = s.acquire().then((r) => (order.push(4), r));
    expect(s.waiting).toBe(2);
    r1();
    (await p3)();
    r2();
    (await p4)();
    expect(order).toEqual([3, 4]);
    expect(s.inUse).toBe(0);
    const ctrl = new AbortController();
    const held = [await s.acquire(), await s.acquire()];
    const waiting = s.acquire(ctrl.signal);
    ctrl.abort(new Error('stop'));
    await expect(waiting).rejects.toThrow('stop');
    held.forEach((r) => r());
  });

  it('ranks by Borda count, ties broken by mean score', () => {
    const v = (ranking: string[], totals: Record<string, number>) => ({
      verdict: { category: 'math', ranking, scores: Object.entries(totals).map(([id, total]) => ({ id, correctness: total, completeness: total, clarity: total, total })), best_parts: [] },
      byLabel: new Map([
        ['A', 'm1'],
        ['B', 'm2'],
        ['C', 'm3'],
      ]),
    });
    const r = aggregate(['m1', 'm2', 'm3'], [v(['B', 'A', 'C'], { A: 6, B: 8, C: 2 }), v(['A', 'B', 'C'], { A: 7, B: 7, C: 3 })]);
    // m1 and m2 both get 3 points; m2 has the higher mean score
    expect(r.ranking.map((x) => x.model)).toEqual(['m2', 'm1', 'm3']);
    expect(r.ranking[0]).toMatchObject({ rank: 1, points: 3, score: 7.5 });
    expect(r.category).toBe('math');
  });
});

describe('council runs (API)', () => {
  it('asks every member, judges blind, synthesizes, and records the leaderboard', async () => {
    const judged: string[] = [];
    let synthSeen = '';
    h.qoder.setReply((t, model) => {
      if (isJudge(t)) {
        judged.push(model);
        return judgeRanking(t, 'qfmodel');
      }
      if (isSynth(t)) {
        synthSeen = t;
        return 'FINAL: merged answer';
      }
      return undefined;
    });
    const created = await h.api('/api/v1/runs', { method: 'POST', json: { kind: 'council', input: { prompt: 'how do I reverse a list in python?', models: ['efficient', 'fast', 'qfmodel'] } } });
    expect(created.status).toBe(201);
    const run = await json(created);
    expect(run).toMatchObject({ kind: 'council', status: 'queued' });

    const done = await waitRun(run.id);
    expect(done.status).toBe('completed');
    expect(done.result).toMatchObject({ text: 'FINAL: merged answer', winner: 'qfmodel', category: 'coding', members: 3, answered: 3, synthesized_by: 'ultimate' });
    expect(done.result.ranking.map((r: any) => r.model)[0]).toBe('qfmodel');
    expect(judged.sort()).toEqual(['efficient', 'ultimate']);
    // the synthesizer gets the winner first, anonymised
    expect(synthSeen).toContain('<answer_A>\n[qfmodel]');
    expect(synthSeen.match(/clear example/g)).toHaveLength(1); // the same note from two judges is listed once
    const keys = done.steps.map((s: any) => s.key).sort();
    expect(keys).toEqual(['answer:efficient', 'answer:fast', 'answer:qfmodel', 'judge:0:ultimate', 'judge:1:efficient', 'stats', 'synthesize'].sort());
    expect(done.credits).toBeGreaterThan(0);

    // hidden helper conversations stay out of the chat list
    const convs = await json(await h.api('/api/v1/conversations'));
    expect(convs.data.some((c: any) => /^council:/.test(c.title ?? ''))).toBe(false);

    const board = await json(await h.api('/api/v1/admin/council/leaderboard', { key: h.admin.apiKey }));
    const q = board.data.find((r: any) => r.model === 'qfmodel');
    expect(q).toMatchObject({ runs: 1, wins: 1, win_rate: 1, mean_rank: 1 });
    expect(board.categories).toEqual([{ category: 'coding', runs: 1 }]);
    expect((await h.api('/api/v1/admin/council/leaderboard')).status).toBe(403);
  });

  it('uses every active model for models: all, and survives judges that never return JSON', async () => {
    let judgeCalls = 0;
    h.qoder.setReply((t) => {
      if (isJudge(t)) {
        judgeCalls++;
        return 'I think A is best.';
      }
      return isSynth(t) ? 'synth' : undefined;
    });
    const run = await json(await h.api('/api/v1/runs', { method: 'POST', json: { kind: 'council', input: { prompt: 'hi', mode: 'best' } } }));
    const done = await waitRun(run.id);
    expect(done.status).toBe('completed');
    const active = h.ctx.models.listActive().length;
    expect(done.result.members).toBe(active);
    // 2 judges × 3 attempts (the retry is told the reply was not JSON), then ranking falls back to answer order
    expect(judgeCalls).toBe(6);
    expect(done.result.text).toMatch(/Echo/);
    expect(done.state.members).toHaveLength(active);
  });

  it('streams the run over SSE and validates input', async () => {
    h.qoder.setReply((t) => (isJudge(t) ? judgeRanking(t, 'fast') : isSynth(t) ? 'done' : undefined));
    expect((await h.api('/api/v1/runs', { method: 'POST', json: { kind: 'nope', input: { prompt: 'x' } } })).status).toBe(400);
    expect((await h.api('/api/v1/runs', { method: 'POST', json: { kind: 'council', input: {} } })).status).toBe(400);
    expect((await h.api('/api/v1/runs', { method: 'POST', json: { kind: 'council', input: { prompt: 'x', attachments: ['file_nope'] } } })).status).toBe(404);

    const run = await json(await h.api('/api/v1/runs', { method: 'POST', json: { kind: 'council', input: { prompt: 'stream me', models: ['efficient', 'fast'] } } }));
    const frames = await readSse(await h.api(`/api/v1/runs/${run.id}/events`));
    expect(frames[0]!.event).toBe('run');
    const types = frames.map((f) => f.event);
    expect(types).toContain('answer.delta');
    expect(types).toContain('council.ranking');
    expect(types.at(-1)).toBe('run.completed');
    expect(frames.at(-1)!.data.result.winner).toBe('fast');

    // after the end the stream is just the snapshot
    const again = await readSse(await h.api(`/api/v1/runs/${run.id}/events`));
    expect(again.map((f) => f.event)).toEqual(['run']);
    expect(again[0]!.data.status).toBe('completed');

    const list = await json(await h.api('/api/v1/runs?kind=council&limit=1'));
    expect(list.data).toHaveLength(1);
    expect(list.has_more).toBe(true);
    expect(list.data[0].input).toBeUndefined();
  });

  it('resumes after a restart without re-asking members that already answered', async () => {
    let answers = 0;
    h.qoder.setReply((t) => {
      if (isJudge(t)) return judgeRanking(t, 'efficient');
      if (isSynth(t)) return 'resumed final';
      answers++;
      return undefined;
    });
    const run = await json(await h.api('/api/v1/runs', { method: 'POST', json: { kind: 'council', input: { prompt: 'resume me', models: ['efficient', 'fast'] } } }));
    await waitRun(run.id);
    expect(answers).toBe(2);
    // simulate a crash after the answers: judge/synth/stats steps lost, run left `running`
    const db = h.ctx.database.db;
    const steps = await db.select().from(runSteps).where(eq(runSteps.runId, run.id));
    for (const s of steps) if (!s.key.startsWith('answer:')) await db.delete(runSteps).where(eq(runSteps.id, s.id));
    await db.update(runs).set({ status: 'running', result: null }).where(eq(runs.id, run.id));
    await h.ctx.runs.start();
    const done = await waitRun(run.id);
    expect(done.status).toBe('completed');
    expect(done.result.text).toBe('resumed final');
    expect(answers).toBe(2); // the two answers came from the stored steps
  });

  it('cancels a running council', async () => {
    const run = await json(await h.api('/api/v1/runs', { method: 'POST', json: { kind: 'council', input: { prompt: '[[slow]] take your time', models: ['efficient'] } } }));
    await waitRun(run.id, (r) => r.status === 'running');
    const res = await json(await h.api(`/api/v1/runs/${run.id}/cancel`, { method: 'POST' }));
    expect(res.status).toBe('cancelled');
    expect((await json(await h.api(`/api/v1/runs/${run.id}`))).status).toBe('cancelled');
    expect((await h.api(`/api/v1/runs/${run.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await h.api(`/api/v1/runs/${run.id}`)).status).toBe(404);
  });
});

describe('council as a chat model', () => {
  it('is listed as a model', async () => {
    const native = await json(await h.api('/api/v1/models'));
    expect(native.data.filter((m: any) => m.provider === 'stillgpt').map((m: any) => m.id)).toEqual(['council', 'council-debate', 'research', 'research-deep']);
    const openai = await json(await h.api('/v1/models'));
    expect(openai.data.some((m: any) => m.id === 'council' && m.owned_by === 'stillgpt')).toBe(true);
  });

  it('answers a chat turn: run events while it works, the synthesized reply as the message', async () => {
    h.qoder.setReply((t) => (isJudge(t) ? judgeRanking(t, 'fast') : isSynth(t) ? 'The council says hello' : undefined));
    const conv = await json(await h.api('/api/v1/conversations', { method: 'POST', json: { model: 'council', profile: 'chat' } }));
    const frames = await readSse(await h.api(`/api/v1/conversations/${conv.id}/messages`, { method: 'POST', json: { text: 'say hello' }, headers: { accept: 'text/event-stream' } }));
    const types = frames.map((f) => f.event);
    expect(types[0]).toBe('turn.started');
    expect(frames[0]!.data.model).toBe('council');
    expect(types).toContain('run.event');
    expect(frames.find((f) => f.event === 'run.event' && f.data.event.type === 'answer.delta')).toBeTruthy();
    const deltas = frames.filter((f) => f.event === 'text.delta').map((f) => f.data.text).join('');
    expect(deltas).toBe('The council says hello');
    const end = frames.find((f) => f.event === 'turn.completed')!;
    expect(end.data).toMatchObject({ stop_reason: 'end_turn', text: 'The council says hello' });

    const msgs = await json(await h.api(`/api/v1/conversations/${conv.id}/messages`));
    expect(msgs.data.map((m: any) => [m.role, m.model])).toEqual([
      ['user', null],
      ['assistant', 'council'],
    ]);
    expect(msgs.data[1].content[0].text).toBe('The council says hello');
    const linked = (await json(await h.api('/api/v1/runs?kind=council&limit=1'))).data[0];
    expect(linked).toMatchObject({ conversation_id: conv.id, message_id: msgs.data[1].id, status: 'completed' });

    // the next turn gives every member the chat so far
    let seen = '';
    h.qoder.setReply((t) => {
      if (isJudge(t)) return judgeRanking(t, 'fast');
      if (isSynth(t)) return 'second';
      seen ||= t;
      return undefined;
    });
    await json(await h.api(`/api/v1/conversations/${conv.id}/messages`, { method: 'POST', json: { text: 'and again' } }));
    expect(seen).toContain('Assistant: The council says hello');
  });

  it('council-debate lets members revise, and works over the OpenAI API', async () => {
    let debates = 0;
    h.qoder.setReply((t) => {
      if (isDebate(t)) {
        debates++;
        return 'revised answer';
      }
      if (isJudge(t)) return judgeRanking(t, 'efficient');
      return isSynth(t) ? 'debated final' : undefined;
    });
    const res = await h.api('/v1/chat/completions', { method: 'POST', json: { model: 'council-debate', messages: [{ role: 'user', content: 'debate this' }] } });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.model).toBe('council-debate');
    expect(body.choices[0].message.content).toBe('debated final');
    expect(debates).toBe(h.ctx.models.listActive().length);
  });

  it('stops the run when the chat turn is interrupted', async () => {
    const conv = await json(await h.api('/api/v1/conversations', { method: 'POST', json: { model: 'council', profile: 'chat' } }));
    const pending = h.api(`/api/v1/conversations/${conv.id}/messages`, { method: 'POST', json: { text: '[[slow]] long one' } });
    await new Promise((r) => setTimeout(r, 150));
    expect((await json(await h.api(`/api/v1/conversations/${conv.id}/interrupt`, { method: 'POST' }))).interrupted).toBe(true);
    const r = await json(await pending);
    expect(r.message.stop_reason).toBe('interrupted');
    const run = (await json(await h.api('/api/v1/runs?kind=council&limit=1'))).data[0];
    expect(run.status).toBe('cancelled');
  });
});

describe('debate verdicts and judge quality', () => {
  it('reads and strips the VERDICT line', () => {
    expect(parseDebate('VERDICT: revised\n\nThe ball costs 500.')).toEqual({ changed: true, text: 'The ball costs 500.' });
    expect(parseDebate('**VERDICT: kept**\nSame answer.')).toEqual({ changed: false, text: 'Same answer.' });
    expect(parseDebate('No verdict here')).toEqual({ changed: null, text: 'No verdict here' });
  });

  it('flags judges that rank by label order or score everyone the same', () => {
    const labels = ['A', 'B', 'C', 'D', 'E', 'F'];
    const v = (ranking: string[], totals: number[]) => ({ category: 'math', ranking, best_parts: [], scores: totals.map((total, i) => ({ id: labels[i]!, correctness: total, completeness: total, clarity: total, total })) });
    expect(judgeQuality(v(['B', 'C', 'D', 'E', 'F', 'A'], [9, 3, 8, 7, 6, 5]), labels)).toEqual({ lazy: true, reason: 'ranked in label order' });
    expect(judgeQuality(v(['D', 'A', 'F', 'B', 'E', 'C'], [9, 9.2, 9.1, 9.3, 9, 9.4]), labels)).toEqual({ lazy: true, reason: 'gave every answer the same score' });
    expect(judgeQuality(v(['D', 'A', 'F', 'B', 'E', 'C'], [9, 3, 8, 7, 6, 5]), labels)).toEqual({ lazy: false });
  });
});

describe('council transparency', () => {
  it('streams debate revisions, reports every judge, down-weights a lazy one and gives the first judge a sandbox', async () => {
    h.qoder.setReply((t, model) => {
      if (t.startsWith('You answered a question together')) return model === 'fast' ? 'VERDICT: revised\n\nfast changed its mind' : 'VERDICT: kept\n\nsame as before';
      if (isJudge(t)) {
        const ids = [...t.matchAll(/<answer id="([A-Z]+)">\n([^\n]*)/g)].map((m) => ({ id: m[1]!, text: m[2]! }));
        // the efficient judge is lazy (label order); the others put the revised `fast` answer first
        const ranking = model === 'efficient' ? ids.map((x) => x.id) : [...ids].reverse().sort((a, b) => Number(b.text.includes('changed its mind')) - Number(a.text.includes('changed its mind'))).map((x) => x.id);
        return JSON.stringify({ category: 'math', scores: ranking.map((id, i) => ({ id, correctness: 9 - i, completeness: 8, clarity: 8, total: 9 - i, note: `note ${id}` })), ranking, best_parts: [] });
      }
      return isSynth(t) ? 'final' : undefined;
    });
    const run = await json(await h.api('/api/v1/runs', { method: 'POST', json: { kind: 'council', input: { prompt: 'q', models: ['efficient', 'fast', 'qfmodel', 'ultimate'], mode: 'debate', judges: ['ultimate', 'efficient', 'qfmodel'] } } }));
    const frames = await readSse(await h.api(`/api/v1/runs/${run.id}/events`));
    expect(frames.filter((f) => f.event === 'debate.delta').length).toBeGreaterThan(0);
    const dones = frames.filter((f) => f.event === 'debate.done').map((f) => f.data);
    expect(dones.find((d: any) => d.model === 'fast')).toMatchObject({ round: 1, ok: true, changed: true });
    expect(dones.find((d: any) => d.model === 'qfmodel')).toMatchObject({ changed: false });
    expect(frames.some((f) => f.event === 'council.judges')).toBe(true);

    const done = await waitRun(run.id);
    const r = done.result;
    expect(r.winner).toBe('fast');
    expect(r.revisions).toHaveLength(4);
    const lazy = r.judges.find((j: any) => j.judge === 'efficient');
    expect(lazy).toMatchObject({ ok: true, lazy: true, reason: 'ranked in label order', weight: 0.25 });
    const first = r.judges.find((j: any) => j.judge === 'ultimate');
    expect(first).toMatchObject({ ok: true, checker: true, lazy: false, top: 'fast' });
    expect(Object.keys(first.scores).sort()).toEqual(['efficient', 'fast', 'qfmodel', 'ultimate']);
    expect(first.scores.fast.note).toMatch(/^note [A-Z]$/);
    expect(r.agreement).toEqual({ agree: 2, judges: 2, split: false });
    // the stored answer of `fast` is the revision without its VERDICT line
    const step = done.steps.find((s: any) => s.key === 'debate:1:fast');
    expect(step.output.text).toMatch(/^VERDICT: revised/);
    // the sandbox judge ran on the research profile (Bash), the others on plain chat
    const judgeConv = async (key: string) => {
      const [step] = await h.ctx.database.db.select().from(runSteps).where(and(eq(runSteps.runId, run.id), eq(runSteps.key, key)));
      const id = step!.conversationId!;
      return (await h.ctx.database.db.select().from(conversations).where(eq(conversations.id, id)))[0]!.profile;
    };
    expect(await judgeConv('judge:0:ultimate')).toBe('research');
    expect(await judgeConv('judge:1:efficient')).toBe('chat');
  });
});
