/**
 * State and shared helpers of the fake Qoder Cloud Agents API.
 *
 * Everything here is transport-agnostic: the HTTP layer lives in `index.ts`, the scripted agent in `script.ts`.
 * Shapes follow docs/QODER_API_NOTES.md (observed live against the real API).
 */

export const MODEL_UNAVAILABLE = "Field 'model' must reference an available model.";

/** Built-in tool names accepted inside an `agent_toolset_20260401` entry. */
export const KNOWN_TOOLS = [
  'Read',
  'Bash',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'ImageSearch',
  'ImageGen',
  'VideoGen',
  'DeliverArtifacts',
] as const;

export const TOOLSET_TYPE = 'agent_toolset_20260401';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'conflict_error'
  | 'rate_limit'
  | 'api_error'
  | 'feature_not_available';

/** Thrown by handlers; rendered as the upstream error envelope. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: ErrorType,
    message: string,
    readonly param?: string,
  ) {
    super(message);
  }
}

/** Default envelope error type for a bare HTTP status (used by `failNext`). */
export function errorTypeForStatus(status: number): ErrorType {
  switch (status) {
    case 400:
      return 'invalid_request_error';
    case 401:
      return 'authentication_error';
    case 403:
      return 'permission_error';
    case 404:
      return 'not_found_error';
    case 409:
      return 'conflict_error';
    case 429:
      return 'rate_limit';
    default:
      return 'api_error';
  }
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** A model as configured by tests; only `id` is required, the rest gets realistic defaults. */
export interface MockModel {
  id: string;
  display_name?: string;
  source?: string;
  is_enabled?: boolean;
  is_new?: boolean;
  price_factor?: number;
  is_vl?: boolean;
  support_disable_reasoning?: boolean;
  max_input_tokens?: number;
  default_context_window?: number;
  efforts?: string[];
  default_effort?: string | null;
  available_context_windows?: number[];
}

/** The `GET /models` item shape. */
export interface ModelObject {
  id: string;
  type: 'model';
  display_name: string;
  source: string;
  is_enabled: boolean;
  is_new: boolean;
  price_factor: number;
  is_vl: boolean;
  support_disable_reasoning: boolean;
  max_input_tokens: number;
  default_context_window: number;
  efforts: string[];
  default_effort: string | null;
  available_context_windows: number[];
}

export interface ModelRecord {
  model: ModelObject;
  /** false once `retireModel` was called — retired models vanish from GET /models and fail validation. */
  active: boolean;
}

export const DEFAULT_MODELS: MockModel[] = [
  { id: 'auto', display_name: 'Auto', price_factor: 1, is_vl: true, efforts: [], default_effort: null },
  { id: 'efficient', display_name: 'Efficient', price_factor: 0, is_vl: true },
  {
    id: 'fast',
    display_name: 'Fast',
    price_factor: 0.5,
    is_vl: true,
    max_input_tokens: 128000,
    default_context_window: 128000,
    available_context_windows: [128000],
  },
  {
    id: 'ultimate',
    display_name: 'Ultimate',
    price_factor: 2,
    is_vl: true,
    efforts: ['low', 'medium', 'high'],
    max_input_tokens: 1000000,
    available_context_windows: [200000, 1000000],
  },
  {
    id: 'qfmodel',
    display_name: 'Qwen3.7-Flash',
    price_factor: 0.3,
    is_vl: false,
    support_disable_reasoning: true,
    max_input_tokens: 256000,
    default_context_window: 256000,
    available_context_windows: [256000],
  },
  {
    id: 'kmodel_latest',
    display_name: 'Kimi-K3',
    price_factor: 1,
    is_vl: false,
    is_new: true,
    max_input_tokens: 256000,
    default_context_window: 256000,
    available_context_windows: [256000],
  },
  {
    id: 'dfmodel',
    display_name: 'DeepSeek-V4-Flash',
    price_factor: 0.2,
    is_vl: false,
    support_disable_reasoning: true,
    max_input_tokens: 128000,
    default_context_window: 128000,
    available_context_windows: [128000],
  },
];

export function normalizeModel(m: MockModel): ModelObject {
  const ctx = m.default_context_window ?? 200000;
  return {
    id: m.id,
    type: 'model',
    display_name: m.display_name ?? m.id,
    source: m.source ?? 'system',
    is_enabled: m.is_enabled ?? true,
    is_new: m.is_new ?? false,
    price_factor: m.price_factor ?? 1,
    is_vl: m.is_vl ?? true,
    support_disable_reasoning: m.support_disable_reasoning ?? false,
    max_input_tokens: m.max_input_tokens ?? ctx,
    default_context_window: ctx,
    efforts: m.efforts ?? ['low', 'high'],
    default_effort: m.default_effort === undefined ? 'high' : m.default_effort,
    available_context_windows: m.available_context_windows ?? [ctx],
  };
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface EnvironmentObject {
  id: string;
  type: 'environment';
  name: string;
  description: string | null;
  config: { type: 'cloud'; networking: { type: 'unrestricted' } };
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface AgentModelRef {
  id: string;
  effort?: string;
}

export type ToolSpec = Record<string, unknown> & { type: string };

export interface AgentObject {
  id: string;
  type: 'agent';
  name: string;
  description: string | null;
  model: AgentModelRef;
  system: string | null;
  tools: ToolSpec[];
  metadata: Record<string, string>;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

/** The agent snapshot embedded in a session (what the session actually runs with). */
export interface SessionAgentSnapshot {
  id: string;
  name: string;
  model: AgentModelRef & { effective_context_window: number };
  system: string | null;
  tools: ToolSpec[];
  version: number;
}

export interface Budget {
  type: 'limit';
  max_credit_cost: string;
}

export interface ResourceObject {
  id: string;
  type: 'file';
  file_id: string;
  mount_path: string;
  created_at: string;
}

export interface FileRecord {
  id: string;
  type: 'file';
  filename: string;
  size_bytes: number;
  mime_type: string;
  downloadable: boolean;
  scope: { id: string; type: 'session' } | null;
  metadata: Record<string, string>;
  created_at: string;
  /** Raw content (not part of the public object). */
  bytes: Buffer;
}

/** A buffered session event, exactly as listed / streamed. */
export interface QoderEvent {
  id: string;
  type: string;
  processed_at: string;
  [field: string]: unknown;
}

/** An open SSE connection on a session. */
export interface Subscriber {
  /** Event types for which delta frames were requested (`event_deltas[]=…`). */
  deltas: Set<string>;
  write(frame: string): void;
}

export interface SessionRecord {
  id: string;
  status: 'idle' | 'running' | 'terminated';
  title: string | null;
  metadata: Record<string, string>;
  budget: Budget | null;
  agent: SessionAgentSnapshot;
  environment_id: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  /** Buffered events, ascending. */
  events: QoderEvent[];
  resources: ResourceObject[];
  /** Text of every user.message so far (including the one currently being processed). */
  userTexts: string[];
  /** Credits consumed by the session so far. */
  credits: number;
  activeMs: number;
  /** Non-null while a turn is running. */
  turn: { controller: AbortController; startedAt: number } | null;
  subscribers: Set<Subscriber>;
}

export interface RequestLogEntry {
  at: string;
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  /** Parsed JSON body, `'<multipart>'` for uploads, or undefined. */
  body: unknown;
  status: number;
}

export interface MockState {
  models: Map<string, ModelRecord>;
  environments: Map<string, EnvironmentObject>;
  agents: Map<string, AgentObject>;
  sessions: Map<string, SessionRecord>;
  files: Map<string, FileRecord>;
  requestLog: RequestLogEntry[];
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export const nowIso = (): string => new Date().toISOString();

/** Rounds credit arithmetic so 0.01 + 0.05 doesn't print as 0.060000000000000005. */
export const roundCredits = (n: number): number => Math.round(n * 1e6) / 1e6;

export function sseFrame(id: string | undefined, event: string, data: unknown): string {
  return `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class MockCore {
  readonly state: MockState = {
    models: new Map(),
    environments: new Map(),
    agents: new Map(),
    sessions: new Map(),
    files: new Map(),
    requestLog: [],
  };

  private counters = new Map<string, number>();

  constructor(models: MockModel[]) {
    for (const m of models) this.state.models.set(m.id, { model: normalizeModel(m), active: true });
  }

  /** Deterministic ids: `evt_000001`, `sess_000001`, … (one counter per prefix). */
  nextId(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}_${String(n).padStart(6, '0')}`;
  }

  /** Deterministic uuid-shaped request id. */
  nextRequestId(): string {
    const n = (this.counters.get('req') ?? 0) + 1;
    this.counters.set('req', n);
    return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  }

  activeModel(id: string): ModelObject | undefined {
    const rec = this.state.models.get(id);
    return rec?.active ? rec.model : undefined;
  }

  /** Validates a `model` field (string id or `{id, effort}`) against active models. */
  resolveModelRef(ref: unknown): { ref: AgentModelRef; model: ModelObject } {
    let id: unknown;
    let effort: unknown;
    if (typeof ref === 'string') id = ref;
    else if (ref && typeof ref === 'object') ({ id, effort } = ref as { id?: unknown; effort?: unknown });
    const model = typeof id === 'string' ? this.activeModel(id) : undefined;
    if (!model) throw new ApiError(400, 'invalid_request_error', MODEL_UNAVAILABLE, 'model');
    if (effort === undefined || effort === null) return { ref: { id: model.id }, model };
    if (typeof effort !== 'string' || !model.efforts.includes(effort)) {
      throw new ApiError(
        400,
        'invalid_request_error',
        `Field 'model.effort' must be one of: ${model.efforts.join(', ') || '(none)'}.`,
        'model.effort',
      );
    }
    return { ref: { id: model.id, effort }, model };
  }

  /** Validates an agent `tools` array (toolset entries + custom tools). */
  validateTools(tools: unknown): ToolSpec[] {
    if (tools === undefined || tools === null) return [];
    if (!Array.isArray(tools)) throw new ApiError(400, 'invalid_request_error', "Field 'tools' must be an array.", 'tools');
    for (const t of tools) {
      if (!t || typeof t !== 'object' || typeof (t as ToolSpec).type !== 'string') {
        throw new ApiError(400, 'invalid_request_error', "Each entry of 'tools' must be an object with a 'type'.", 'tools');
      }
      const spec = t as ToolSpec;
      if (spec.type === TOOLSET_TYPE) {
        const enabled = spec.enabled_tools;
        if (enabled === undefined) continue;
        if (!Array.isArray(enabled)) {
          throw new ApiError(400, 'invalid_request_error', "Field 'enabled_tools' must be an array.", 'tools');
        }
        for (const name of enabled) {
          if (!(KNOWN_TOOLS as readonly unknown[]).includes(name)) {
            throw new ApiError(400, 'invalid_request_error', `unknown tool name '${String(name)}'`, 'tools');
          }
        }
      } else if (spec.type === 'custom') {
        if (typeof spec.name !== 'string' || !spec.name) {
          throw new ApiError(400, 'invalid_request_error', "Custom tools require a 'name'.", 'tools');
        }
      } else {
        throw new ApiError(400, 'invalid_request_error', `unknown tool type '${spec.type}'`, 'tools');
      }
    }
    return tools as ToolSpec[];
  }

  /** Built-in tools enabled by a tools array (a toolset without `enabled_tools` enables all of them). */
  enabledTools(tools: ToolSpec[]): Set<string> {
    const out = new Set<string>();
    for (const t of tools) {
      if (t.type !== TOOLSET_TYPE) continue;
      const list = Array.isArray(t.enabled_tools) ? (t.enabled_tools as string[]) : [...KNOWN_TOOLS];
      for (const name of list) out.add(name);
    }
    return out;
  }

  getSession(id: string): SessionRecord {
    const s = this.state.sessions.get(id);
    if (!s) throw new ApiError(404, 'not_found_error', `Session ${id} not found.`);
    return s;
  }

  getFile(id: string): FileRecord {
    const f = this.state.files.get(id);
    if (!f) throw new ApiError(404, 'not_found_error', `File ${id} not found.`);
    return f;
  }

  createFile(input: {
    filename: string;
    bytes: Buffer;
    mimeType: string;
    downloadable?: boolean;
    scope?: FileRecord['scope'];
  }): FileRecord {
    const file: FileRecord = {
      id: this.nextId('file'),
      type: 'file',
      filename: input.filename,
      size_bytes: input.bytes.length,
      mime_type: input.mimeType,
      downloadable: input.downloadable ?? false,
      scope: input.scope ?? null,
      metadata: {},
      created_at: nowIso(),
      bytes: input.bytes,
    };
    this.state.files.set(file.id, file);
    return file;
  }

  /**
   * Appends a buffered event and pushes it to every open stream.
   * `id` may be pre-allocated (used when delta frames were already sent under that id).
   */
  appendEvent(s: SessionRecord, type: string, fields: Record<string, unknown> = {}, id?: string): QoderEvent {
    const evt: QoderEvent = { id: id ?? this.nextId('evt'), type, processed_at: nowIso(), ...fields };
    s.events.push(evt);
    const frame = sseFrame(evt.id, evt.type, evt);
    for (const sub of s.subscribers) sub.write(frame);
    return evt;
  }

  /** Sends a non-buffered frame (event_start / event_delta) to the given subscribers. */
  sendTransient(subs: Iterable<Subscriber>, id: string, event: string, data: unknown): void {
    const frame = sseFrame(id, event, data);
    for (const sub of subs) sub.write(frame);
  }
}

export function publicFile(f: FileRecord): Omit<FileRecord, 'bytes'> {
  const { bytes: _bytes, ...rest } = f;
  return rest;
}

export function publicSession(s: SessionRecord): Record<string, unknown> {
  const now = Date.now();
  const activeMs = s.activeMs + (s.turn ? now - s.turn.startedAt : 0);
  return {
    id: s.id,
    type: 'session',
    status: s.status,
    title: s.title,
    metadata: s.metadata,
    budget: s.budget,
    agent: s.agent,
    environment_id: s.environment_id,
    stats: {
      active_seconds: Math.floor(activeMs / 1000),
      duration_seconds: Math.floor((now - Date.parse(s.created_at)) / 1000),
    },
    usage: { total_credits: roundCredits(s.credits) },
    created_at: s.created_at,
    updated_at: s.updated_at,
    archived_at: s.archived_at,
  };
}

/** Builds the upstream list envelope. */
export function listEnvelope<T extends { id: string }>(items: T[], hasMore = false): Record<string, unknown> {
  return {
    data: items,
    first_id: items[0]?.id ?? null,
    last_id: items.at(-1)?.id ?? null,
    has_more: hasMore,
    next_page: hasMore ? (items.at(-1)?.id ?? null) : null,
  };
}

/**
 * Applies `limit` / `after_id` / `before_id` to an already-ordered array.
 * Unknown cursors yield an empty page after the end (after_id) / before the start (before_id).
 */
export function paginate<T extends { id: string }>(items: T[], query: URLSearchParams, defaultLimit = 20): Record<string, unknown> {
  const rawLimit = Number(query.get('limit') ?? defaultLimit);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 1000) : defaultLimit;
  let slice = items;
  const after = query.get('after_id');
  const before = query.get('before_id');
  if (after) {
    const idx = slice.findIndex((i) => i.id === after);
    slice = idx === -1 ? [] : slice.slice(idx + 1);
  }
  if (before) {
    const idx = slice.findIndex((i) => i.id === before);
    slice = idx === -1 ? [] : slice.slice(Math.max(0, idx - limit), idx);
    return listEnvelope(slice, idx > limit);
  }
  return listEnvelope(slice.slice(0, limit), slice.length > limit);
}
