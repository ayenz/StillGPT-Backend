import { eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { kv } from '../db/schema.js';
import { badRequest } from '../errors.js';
import type { Logger } from '../log.js';
import { DEFAULT_INSTRUCTIONS, type EnhanceKind, INSTRUCTIONS_MAX, outputContract } from './enhancer.js';
import { DEFAULT_VARIATION_INSTRUCTIONS, variationContract } from './variations.js';

/** `image`/`video`: the ✨ Enhance rewrite; `variation`: the "other variation" rewrite. */
export type InstructionKind = EnhanceKind | 'variation';
export const INSTRUCTION_KINDS: InstructionKind[] = ['image', 'video', 'variation'];
const keyOf = (kind: InstructionKind) => `enhancer.instructions.${kind}`;

const defaultOf = (kind: InstructionKind) => (kind === 'variation' ? DEFAULT_VARIATION_INSTRUCTIONS : DEFAULT_INSTRUCTIONS[kind]);
const contractOf = (kind: InstructionKind) => (kind === 'variation' ? variationContract() : outputContract(kind));

interface Stored {
  text: string;
  updatedAt: string;
}

export interface EnhancerInstructionsStatus {
  kind: InstructionKind;
  /** What the enhancer uses now. */
  instructions: string;
  /** `admin` = saved via the admin API, `default` = built in. */
  source: 'admin' | 'default';
  updatedAt: string | null;
  default: string;
  /** Fixed rules + JSON reply format always appended after `instructions` (not editable). */
  contract: string;
}

/**
 * Admin-editable enhancer instructions per kind, stored in `kv` and cached in memory, so a change applies
 * to the next enhance request without a restart. Only the persona/style part is editable; the output
 * contract (allowed ratios, JSON shape, safety rules) stays in code.
 */
export class EnhancerInstructions {
  private stored: Partial<Record<InstructionKind, Stored>> = {};

  constructor(private readonly d: { db: DB; log: Logger }) {}

  async load(): Promise<void> {
    const rows = await this.d.db.select().from(kv).where(inArray(kv.key, INSTRUCTION_KINDS.map(keyOf)));
    for (const kind of INSTRUCTION_KINDS) {
      const row = rows.find((r) => r.key === keyOf(kind));
      const v = row?.value as Stored | undefined;
      if (v?.text) this.stored[kind] = v;
    }
  }

  get(kind: InstructionKind): string {
    return this.stored[kind]?.text ?? defaultOf(kind);
  }

  status(kind: InstructionKind): EnhancerInstructionsStatus {
    const s = this.stored[kind];
    return {
      kind,
      instructions: this.get(kind),
      source: s ? 'admin' : 'default',
      updatedAt: s?.updatedAt ?? null,
      default: defaultOf(kind),
      contract: contractOf(kind),
    };
  }

  /** Save new instructions for `kind`; `null` resets to the built-in default. */
  async set(kind: InstructionKind, text: string | null): Promise<EnhancerInstructionsStatus> {
    if (text === null) {
      await this.d.db.delete(kv).where(eq(kv.key, keyOf(kind)));
      delete this.stored[kind];
      this.d.log.info('enhancer.instructions_reset', { kind });
      return this.status(kind);
    }
    const value: Stored = { text: validateInstructions(text), updatedAt: new Date().toISOString() };
    await this.d.db
      .insert(kv)
      .values({ key: keyOf(kind), value })
      .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
    this.stored[kind] = value;
    this.d.log.info('enhancer.instructions_updated', { kind, length: value.text.length });
    return this.status(kind);
  }
}

export function validateInstructions(text: string): string {
  const t = text.trim();
  if (t.length < 20) throw badRequest('instructions are too short (min 20 characters)', 'validation_error');
  if (t.length > INSTRUCTIONS_MAX) throw badRequest(`instructions are longer than ${INSTRUCTIONS_MAX} characters`, 'validation_error');
  return t;
}
