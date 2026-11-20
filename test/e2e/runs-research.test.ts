import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type Finding, numberSources } from '../../src/core/runs/research.js';
import { type Harness, startHarness } from './harness.js';
import { readSse } from './native-sse.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ env: { RUN_RETRY_BASE_MS: '5' } });
});
afterEach(() => h.qoder.setReply(undefined));
afterAll(() => h?.close());

const json = async (res: Response) => (await res.json()) as any;

async function waitRun(id: string, until = (r: any) => ['completed', 'failed', 'cancelled', 'awaiting_input'].includes(r.status)) {
  for (let i = 0; i < 600; i++) {
    const r = await json(await h.api(`/api/v1/runs/${id}`));
    if (until(r)) return r;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`run ${id} did not settle`);
}

interface Seen {
  plan: number;
  workers: string[];
  gaps: number;
  verifies: string[];
  sections: string[];
  editor: string;
  render: string;
}

/** Scripted research team: plan with 3 questions / 2 sections, one follow-up round, numbered sources. */
function script(o: { followUp?: boolean; plan?: object } = {}): Seen {
  const seen: Seen = { plan: 0, workers: [], gaps: 0, verifies: [], sections: [], editor: '', render: '' };
  h.qoder.setReply((t) => {
    if (t.startsWith('You plan a deep research report')) {
      seen.plan++;
      return JSON.stringify(
        o.plan ?? {
          title: 'Kopi Susu Market 2026',
          language: 'Indonesian',
          objective: 'size the market',
          sub_questions: [
            { question: 'How big is the market?', search_hints: ['kopi susu market size'] },
            { question: 'Who are the main brands?' },
            { question: 'What are the prices?' },
          ],
          outline: [
            { heading: 'Market', covers: ['q1', 'q3'] },
            { heading: 'Players', covers: ['q2'] },
          ],
        },
      );
    }
    if (t.startsWith('You are one research agent')) {
      const q = /<your_sub_question>\n([^\n]*)/.exec(t)![1]!;
      seen.workers.push(q);
      const n = seen.workers.length;
      return (
        'Here is what I found:\n```json\n' +
        JSON.stringify({
          summary: `summary of ${q}`,
          findings: [
            { claim: `claim A about ${q}`, evidence: 'quote', url: `https://example.com/${n}?utm_source=x`, title: `Source ${n}`, confidence: 'high' },
            { claim: `shaky claim about ${q}`, url: 'https://shared.example.org/report', title: 'Shared report', confidence: 'medium' },
          ],
          open_questions: [],
        }) +
        '\n```'
      );
    }
    if (t.startsWith('You lead a research team')) {
      seen.gaps++;
      return JSON.stringify(o.followUp && seen.gaps === 1 ? { done: false, follow_ups: [{ question: 'What changed in 2026?' }] } : { done: true, follow_ups: [] });
    }
    if (t.startsWith('Fact-check one claim')) {
      seen.verifies.push(t);
      return JSON.stringify({ verdict: 'unsupported', note: 'not in the source' });
    }
    if (t.startsWith('You write one section')) {
      seen.sections.push(t);
      return `Section body for ${/<section_heading>\n([^\n]*)/.exec(t)![1]} [1][2]`;
    }
    if (t.startsWith('You are the editor')) {
      seen.editor = t;
      return '# Kopi Susu Market 2026\n\n## Executive summary\n- big [1]\n\n## Market\nSection body [1]';
    }
    if (t.includes('Convert the Markdown report')) {
      seen.render = t;
      return 'Delivered.';
    }
    return undefined;
  });
  return seen;
}

describe('numberSources', () => {
  it('numbers unique URLs in order, ignoring tracking params and fragments', () => {
    const f = (url: string): Finding => ({ claim: 'c', evidence: '', url, title: url, confidence: 'high', qid: 'q1', source: 0 });
    const list = [f('https://a.com/x?utm_source=1#top'), f('https://b.com/'), f('https://a.com/x'), f(''), f('ftp://no')];
    const sources = numberSources(list);
    expect(sources.map((s) => s.url)).toEqual(['https://a.com/x', 'https://b.com']);
    expect(list.map((x) => x.source)).toEqual([1, 2, 1, 0, 0]);
  });
});

describe('research runs', () => {
  it('plans, researches in parallel with a follow-up round, writes cited sections and renders files', async () => {
    const seen = script({ followUp: true });
    const run = await json(await h.api('/api/v1/runs', { method: 'POST', json: { kind: 'research', input: { prompt: 'Riset pasar kopi susu 2026', depth: 'standard', formats: ['pdf'] } } }));
    expect(run.kind).toBe('research');
    const done = await waitRun(run.id);
    expect(done.status, JSON.stringify(done.error)).toBe('completed');

    expect(seen.plan).toBe(1);
    // 3 planned questions, then 1 follow-up in round 2 (standard = 2 rounds → one gap analysis)
    expect([...seen.workers].sort()).toEqual(['How big is the market?', 'What are the prices?', 'What changed in 2026?', 'Who are the main brands?']);
    expect(seen.gaps).toBe(1);
    expect(seen.verifies).toHaveLength(0); // fact-checks are for depth deep
    expect(seen.sections).toHaveLength(2);
    // a section gets the findings it covers (+ follow-ups) and only the sources they use
    const market = seen.sections.find((s) => s.includes('<section_heading>\nMarket'))!;
    expect(market).toContain('claim A about How big is the market?');
    expect(market).toContain('claim A about What changed in 2026?');
    expect(market).not.toContain('claim A about Who are the main brands?');
    expect(seen.editor).toContain('Section body for Players');
    expect(seen.render).toContain('kopi-susu-market-2026.pdf');
    expect(seen.render).toContain('/data/attachments/kopi-susu-market-2026.md'); // the report is mounted in the sandbox

    const r = done.result;
    expect(r.title).toBe('Kopi Susu Market 2026');
    // 4 per-question URLs (tracking params dropped) + 1 shared report
    expect(r.sources).toHaveLength(5);
    expect(r.sources.map((s: any) => s.url)).toContain('https://shared.example.org/report');
    // numbered in question order (q1's own source first, then the shared one it also cites), not in finishing order
    const q1 = seen.workers.indexOf('How big is the market?') + 1;
    expect(r.sources.slice(0, 2).map((x: any) => x.url)).toEqual([`https://example.com/${q1}`, 'https://shared.example.org/report']);
    expect(r.text).toMatch(/^# Kopi Susu Market 2026/);
    expect(r.text).toContain(`## Sources\n\n1. [Source ${q1}](https://example.com/${q1})\n2. [Shared report](https://shared.example.org/report)`);
    expect(r.stats).toMatchObject({ questions: 4, answered: 4, findings: 8, sources: 5, rounds: 2, depth: 'standard' });
    expect(r.files).toHaveLength(1);
    expect(r.files[0]).toMatchObject({ name: 'kopi-susu-market-2026.md', mimeType: 'text/markdown' });

    // the Markdown file is downloadable through a normal file URL
    const file = await json(await h.api(`/api/v1/files/${r.files[0].id}`));
    const md = await (await fetch(file.url)).text();
    expect(md).toBe(r.text);
    // worker agents run in the research sandbox profile
    const step = done.steps.find((s: any) => s.key === 'research:q1');
    expect(step).toMatchObject({ status: 'completed', kind: 'turn' });
  });

  it('deep: fact-checks shaky claims and drops the unsupported ones', async () => {
    const seen = script();
    const run = await json(await h.api('/api/v1/runs', { method: 'POST', json: { kind: 'research', input: { prompt: 'deep one', depth: 'deep', formats: [] } } }));
    const done = await waitRun(run.id);
    expect(done.status).toBe('completed');
    expect(seen.verifies).toHaveLength(3); // the 3 medium-confidence claims
    expect(seen.verifies[0]).toContain('https://shared.example.org/report');
    expect(seen.sections.join('\n')).not.toContain('shaky claim');
    expect(seen.render).toBe(''); // no formats → no render turn
    expect(done.result.stats.findings).toBe(3);
  });

  it('pauses for plan review and continues with the edited questions', async () => {
    const seen = script();
    const run = await json(await h.api('/api/v1/runs', { method: 'POST', json: { kind: 'research', input: { prompt: 'review me', depth: 'quick', review_plan: true, formats: [] } } }));
    const waiting = await waitRun(run.id);
    expect(waiting.status).toBe('awaiting_input');
    expect(waiting.state.awaiting).toMatchObject({ key: 'plan_review', what: 'plan' });
    expect(waiting.state.awaiting.plan.sub_questions).toHaveLength(3);
    expect(seen.workers).toHaveLength(0);

    expect((await h.api(`/api/v1/runs/${run.id}/input`, { method: 'POST', json: { value: { sub_questions: [{ question: 'Only this one please' }] } } })).status).toBe(200);
    const done = await waitRun(run.id, (r) => ['completed', 'failed'].includes(r.status));
    expect(done.status).toBe('completed');
    expect(seen.workers).toEqual(['Only this one please']);
    expect(seen.plan).toBe(1); // the plan step was not repeated
    expect((await h.api(`/api/v1/runs/${run.id}/input`, { method: 'POST', json: { value: null } })).status).toBe(409);
  });

  it('fails clearly when no agent found anything', async () => {
    script();
    h.qoder.setReply((t) => (t.startsWith('You plan') ? JSON.stringify({ title: 'x', sub_questions: [{ question: 'q one?' }], outline: [{ heading: 'h' }] }) : t.startsWith('You are one research agent') ? 'no json' : undefined));
    const run = await json(await h.api('/api/v1/runs', { method: 'POST', json: { kind: 'research', input: { prompt: 'nothing', depth: 'quick' } } }));
    const done = await waitRun(run.id);
    expect(done.status).toBe('failed');
    expect(done.error.message).toMatch(/found nothing usable/);
  });
});

describe('research as a chat model', () => {
  it('streams the report as the reply, with the report file attached', async () => {
    script();
    const conv = await json(await h.api('/api/v1/conversations', { method: 'POST', json: { model: 'research' } }));
    const frames = await readSse(await h.api(`/api/v1/conversations/${conv.id}/messages`, { method: 'POST', json: { text: 'riset kopi susu' }, headers: { accept: 'text/event-stream' } }));
    const text = frames.filter((f) => f.event === 'text.delta').map((f) => f.data.text).join('');
    expect(text).toMatch(/^# Kopi Susu Market 2026[\s\S]*## Sources/);
    expect(frames.some((f) => f.event === 'run.event' && f.data.event.type === 'research.question')).toBe(true);
    const end = frames.find((f) => f.event === 'turn.completed')!.data;
    expect(end.stop_reason).toBe('end_turn');
    expect(end.artifacts.map((a: any) => a.name)).toEqual(['kopi-susu-market-2026.md']);

    const msgs = await json(await h.api(`/api/v1/conversations/${conv.id}/messages`));
    expect(msgs.data[1]).toMatchObject({ role: 'assistant', model: 'research' });
    expect(msgs.data[1].artifacts[0].url).toMatch(/\/media\//);
  });
});
