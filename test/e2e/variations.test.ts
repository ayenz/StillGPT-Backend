import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseTraits } from '../../src/core/references.js';
import { parseVariations } from '../../src/core/variations.js';
import { makePng } from '../mock-qoder/index.js';
import { type Harness, startHarness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ env: { MEDIA_POLL_INTERVAL_MS: '50' } });
});
afterEach(() => {
  h.qoder.setReply(undefined);
  h.qoder.setToolError(undefined);
});
afterAll(() => h?.close());

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });
const post = (payload: unknown) => h.api('/api/v1/prompts/variations', { method: 'POST', json: payload });

async function upload(filename = 'ref.png') {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(makePng())], { type: 'image/png' }), filename);
  return (await (await h.api('/api/v1/files', { method: 'POST', body: form })).json()) as { id: string };
}

const TRAITS = '{"subject":"woman in her 20s","outfit":"red silk evening gown","palette":"red, gold","background":"marble ballroom","pose":"standing","lighting":"warm chandelier light","camera":"full body","style":"fashion photo","props":"","text":""}';
const variationsReply = (...prompts: string[]) =>
  JSON.stringify({ variations: prompts.map((p, i) => ({ prompt: p, changed: { outfit: `outfit ${i}`, color: `color ${i}`, background: `bg ${i}` } })) });

/** Scripts both LLM steps and records what each one was sent. */
function script(variations: string) {
  const seen = { describe: [] as string[], vary: [] as string[] };
  h.qoder.setReply((text) => {
    if (text.includes('<describe-reference>')) {
      seen.describe.push(text);
      return TRAITS;
    }
    if (text.includes('<prompt>')) {
      seen.vary.push(text);
      return variations;
    }
    return undefined;
  });
  return seen;
}

const sessionsWith = (marker: string) => [...h.qoder.state.sessions.values()].filter((s) => s.userTexts.some((t) => t.includes(marker)));

describe('parsers', () => {
  it('parseTraits keeps known non-empty fields only', () => {
    expect(parseTraits(`Here: ${TRAITS}`)).toEqual({
      subject: 'woman in her 20s',
      outfit: 'red silk evening gown',
      palette: 'red, gold',
      background: 'marble ballroom',
      pose: 'standing',
      lighting: 'warm chandelier light',
      camera: 'full body',
      style: 'fashion photo',
    });
    expect(parseTraits('no idea')).toBeNull();
    expect(parseTraits('{"outfit":""}')).toBeNull();
  });

  it('parseVariations drops repeats of the original, earlier variations and each other', () => {
    const reply = variationsReply('Base prompt', 'Old one', 'New A', 'new  a', 'New B', 'New C');
    const out = parseVariations(reply, { original: 'base prompt', avoid: ['old one'], n: 2 });
    expect(out.map((v) => v.prompt)).toEqual(['New A', 'New B']);
    expect(out[0]!.changed).toEqual({ outfit: 'outfit 2', color: 'color 2', background: 'bg 2' });
    expect(parseVariations('sorry', { original: 'x', avoid: [], n: 1 })).toEqual([]);
  });
});

describe('POST /api/v1/prompts/variations', () => {
  it('returns n variations with what changed, default axes', async () => {
    const seen = script(variationsReply('Variation one', 'Variation two'));
    const r = await json(await post({ prompt: 'Fashion photo of a woman in a red gown in a ballroom', n: 2 }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      original: 'Fashion photo of a woman in a red gown in a ballroom',
      kind: 'image',
      vary: ['outfit', 'color', 'background'],
      keep: ['subject', 'style', 'text'],
      references: [],
      model: expect.any(String),
      credits: expect.any(Number),
    });
    expect(r.body.variations).toEqual([
      { prompt: 'Variation one', changed: { outfit: 'outfit 0', color: 'color 0', background: 'bg 0' } },
      { prompt: 'Variation two', changed: { outfit: 'outfit 1', color: 'color 1', background: 'bg 1' } },
    ]);
    expect(seen.describe).toHaveLength(0);
    expect(seen.vary[0]).toContain('Write 2 variations of this image prompt.');
    expect(seen.vary[0]).toContain('Change: outfit, color, background.');
    expect(seen.vary[0]).toContain('Keep: subject, style, text.');
  });

  it('reads a reference image once, steers away from it and caches the traits', async () => {
    const ref = await upload();
    const seen = script(variationsReply('A woman in a denim jacket on a rooftop'));
    const before = sessionsWith('<describe-reference>').length;

    const r1 = await json(await post({ prompt: 'woman in red gown', reference_file_ids: [ref.id], avoid: ['woman in a green sari at a beach'] }));
    expect(r1.status).toBe(200);
    expect(r1.body.references).toEqual([{ file_id: ref.id, cached: false, traits: expect.objectContaining({ outfit: 'red silk evening gown', background: 'marble ballroom' }) }]);
    expect(r1.body.variations).toHaveLength(1);
    // the vision turn got the image itself
    const describe = sessionsWith('<describe-reference>').slice(before);
    expect(describe).toHaveLength(1);
    expect(JSON.stringify(describe[0]!.events.find((e) => e.type === 'user.message'))).toContain('"type":"image"');
    // the variation turn knows what to move away from
    expect(seen.vary[0]).toContain('red silk evening gown');
    expect(seen.vary[0]).toContain('clearly different from these references');
    expect(seen.vary[0]).toContain('1. woman in a green sari at a beach');

    const r2 = await json(await post({ prompt: 'woman in red gown', reference_file_ids: [ref.id] }));
    expect(r2.body.references[0]).toMatchObject({ cached: true });
    expect(seen.describe).toHaveLength(1); // not described again
  });

  it('still varies when the reference cannot be read', async () => {
    const ref = await upload('unreadable.png');
    h.qoder.setReply((text) => (text.includes('<describe-reference>') ? 'I cannot see images.' : text.includes('<prompt>') ? variationsReply('Something else') : undefined));
    const r = await json(await post({ prompt: 'cat on a sofa', reference_file_ids: [ref.id] }));
    expect(r.status).toBe(200);
    expect(r.body.references).toEqual([{ file_id: ref.id, traits: null, cached: false }]);
    expect(r.body.variations[0].prompt).toBe('Something else');
  });

  it('custom axes; default keep yields to vary', async () => {
    const seen = script(variationsReply('x'));
    const r = await json(await post({ prompt: 'p', vary: ['style', 'pose'] }));
    expect(r.body).toMatchObject({ vary: ['style', 'pose'], keep: ['subject', 'text'] });
    expect(seen.vary[0]).toContain('Change: style, pose.');
  });

  it('user_prompt locks what the user wrote unless vary is explicit', async () => {
    const seen = script(variationsReply('x'));
    await post({ prompt: 'Enhanced: woman in a red silk dress on a beach', user_prompt: 'gaun merah di pantai' });
    expect(seen.vary[0]).toContain('<user-words>\ngaun merah di pantai\n</user-words>');
    await post({ prompt: 'Enhanced: woman in a red silk dress on a beach', user_prompt: 'gaun merah di pantai', vary: ['color'] });
    expect(seen.vary[1]).not.toContain('<user-words>');
  });

  it('502 when the model gives nothing usable', async () => {
    script('no json here');
    const r = await json(await post({ prompt: 'p' }));
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('variation_failed');
  });

  it('validates the body', async () => {
    expect((await json(await post({}))).status).toBe(400);
    expect((await json(await post({ prompt: ' ' }))).status).toBe(400);
    expect((await json(await post({ prompt: 'p', n: 10 }))).status).toBe(400);
    expect((await json(await post({ prompt: 'p', vary: ['shoes'] }))).status).toBe(400);
    expect((await json(await post({ prompt: 'p', vary: ['outfit'], keep: ['outfit'] }))).body.error.message).toMatch(/both vary and keep/);
    expect((await json(await post({ prompt: 'p', reference_file_ids: ['file_nope'] }))).status).toBe(404);
  });
});

describe('POST /api/v1/images with variations', () => {
  it('the first image keeps the original prompt, the others get variations', async () => {
    const seen = script(variationsReply('Var A', 'Var B'));
    const r = await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'base prompt', n: 3, variations: { vary: ['outfit', 'background'] } } }));
    expect(r.status).toBe(200);
    expect(r.body.jobs.map((j: any) => j.request.prompt)).toEqual(['base prompt', 'Var A', 'Var B']);
    expect(r.body.jobs[0].request).toMatchObject({ batch_index: 0, base_prompt: 'base prompt', variation: { original: true } });
    for (const j of r.body.jobs.slice(1)) {
      expect(j.request).toMatchObject({ base_prompt: 'base prompt', variation: { vary: ['outfit', 'background'], changed: expect.any(Object), repeated: false } });
    }
    for (const j of r.body.jobs) expect(j.status).toBe('completed');
    expect(seen.vary).toHaveLength(1);
    expect(seen.vary[0]).toContain('Write 2 variations'); // n - 1
    // explicit vary: the user chose what changes, so their words do not lock anything
    expect(seen.vary[0]).not.toContain('<user-words>');
  });

  it('default axes keep what the user wrote themselves (their words, not the enhanced text)', async () => {
    const seen = { vary: [] as string[] };
    h.qoder.setReply((text) => {
      if (text.includes('<idea>')) return '{"prompt":"Fashion photo of a woman in a flowing red silk dress on a tropical beach at golden hour","aspect_ratio":"3:4"}';
      if (text.includes('<prompt>')) {
        seen.vary.push(text);
        return variationsReply('V1');
      }
      return undefined;
    });
    const r = await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'cewek pakai gaun merah di pantai', enhance: true, n: 2, variations: true } }));
    expect(r.body.jobs.map((j: any) => j.request.prompt)).toEqual(['Fashion photo of a woman in a flowing red silk dress on a tropical beach at golden hour', 'V1']);
    expect(r.body.jobs[0].request).toMatchObject({ original_prompt: 'cewek pakai gaun merah di pantai', variation: { original: true } });
    expect(seen.vary[0]).toContain('<user-words>\ncewek pakai gaun merah di pantai\n</user-words>');
    expect(seen.vary[0]).toContain('keep it in every variation even if its axis is listed under "Change"');
  });

  it('user_prompt: a prompt enhanced client-side is varied against what the user typed', async () => {
    const seen = script(variationsReply('V1', 'V2'));
    const enhanced = 'Fashion photo of a woman in a flowing red silk dress with gold earrings on a tropical beach at golden hour, 85mm';
    const r = await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: enhanced, user_prompt: 'gaun merah di pantai', n: 3, variations: true } }));
    expect(r.body.jobs.map((j: any) => j.request.prompt)).toEqual([enhanced, 'V1', 'V2']);
    for (const j of r.body.jobs) expect(j.request.user_prompt).toBe('gaun merah di pantai');
    expect(seen.vary[0]).toContain('<user-words>\ngaun merah di pantai\n</user-words>');
    expect(seen.vary[0]).not.toContain(`<user-words>\n${enhanced}`);

    // without user_prompt the sent prompt counts as the user's words (unchanged behaviour)
    await h.api('/api/v1/images', { method: 'POST', json: { prompt: enhanced, n: 2, variations: true } });
    expect(seen.vary[1]).toContain(`<user-words>\n${enhanced}\n</user-words>`);
    expect((await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'p', user_prompt: 5 } }))).status).toBe(400);
  });

  it('n = 1 (or no n) with variations keeps the original prompt and skips the variator', async () => {
    const seen = script(variationsReply('should not be used'));
    const single = await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'base prompt', variations: true } }));
    expect(single.body).toMatchObject({ status: 'completed', request: { prompt: 'base prompt', base_prompt: 'base prompt', variation: { original: true } } });
    const one = await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'base prompt', n: 1, variations: true } }));
    expect(one.body.jobs[0].request).toMatchObject({ prompt: 'base prompt', variation: { original: true } });
    expect(seen.vary).toHaveLength(0);
  });

  it('a batch of 10 is the original plus 9 distinct variations from one call', async () => {
    const seen = script(variationsReply(...Array.from({ length: 9 }, (_, i) => `Var ${i}`)));
    const r = await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'base prompt', n: 10, variations: true, async: true } }));
    expect(r.status).toBe(202);
    expect(r.body.jobs.map((j: any) => j.request.prompt)).toEqual(['base prompt', ...Array.from({ length: 9 }, (_, i) => `Var ${i}`)]);
    expect(r.body.jobs.some((j: any) => j.request.variation?.repeated)).toBe(false);
    expect(seen.vary[0]).toContain('Write 9 variations');
  });

  it('falls back to the original prompt everywhere when variations fail', async () => {
    script('nope');
    const r = await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'base prompt', n: 2, variations: true } }));
    expect(r.status).toBe(200);
    expect(r.body.jobs.map((j: any) => j.request.prompt)).toEqual(['base prompt', 'base prompt']);
    expect(r.body.jobs[0].request).toMatchObject({ variation: { original: true }, variations_failed: true });
    expect(r.body.jobs[1].request.variation).toBeUndefined();
    expect(r.body.jobs[1].request.variations_failed).toBe(true);
  });

  it('rejects bad variation options', async () => {
    const r = await json(await h.api('/api/v1/images', { method: 'POST', json: { prompt: 'p', variations: { vary: ['shoes'] } } }));
    expect(r.status).toBe(400);
  });
});

describe('admin: variation instructions', () => {
  const admin = (path: string, init: RequestInit & { json?: unknown } = {}) => h.api(path, { ...init, key: h.admin.apiKey });

  it('lists, saves and dry-runs the variation instructions', async () => {
    const list = await json(await admin('/api/v1/admin/enhancer/instructions'));
    expect(list.body.data.map((d: any) => d.kind)).toEqual(['image', 'video', 'variation']);
    const v = list.body.data[2];
    expect(v).toMatchObject({ source: 'default' });
    expect(v.contract).toContain('"variations"');

    const seen = script(variationsReply('draft result'));
    const t = await json(await admin('/api/v1/admin/enhancer/test', { method: 'POST', json: { kind: 'variation', prompt: 'p', instructions: 'DRAFT: always switch to winter clothing.' } }));
    expect(t.body).toMatchObject({ instructions_source: 'draft', variations: [{ prompt: 'draft result' }] });
    expect(seen.vary[0]).toContain('DRAFT: always switch to winter clothing.');

    const put = await json(await admin('/api/v1/admin/enhancer/instructions/variation', { method: 'PUT', json: { instructions: 'SAVED: prefer outdoor locations always.' } }));
    expect(put.body).toMatchObject({ kind: 'variation', source: 'admin' });
    await post({ prompt: 'p' });
    expect(seen.vary.at(-1)).toContain('SAVED: prefer outdoor locations always.');
    await admin('/api/v1/admin/enhancer/instructions/variation', { method: 'DELETE' });
  });
});
