/** Upstream payload shapes (Qoder Cloud Agents API). Only fields we rely on are typed. */

export interface QoderList<T> {
  data: T[];
  first_id?: string | null;
  last_id?: string | null;
  has_more: boolean;
  next_page?: string | null;
}

export interface QoderModel {
  id: string;
  display_name?: string;
  is_enabled?: boolean;
  is_new?: boolean;
  is_vl?: boolean;
  price_factor?: number;
  efforts?: string[] | null;
  default_effort?: string | null;
  max_input_tokens?: number | null;
  default_context_window?: number | null;
  available_context_windows?: number[] | null;
  [k: string]: unknown;
}

export type AgentModelRef = string | { id: string; effort?: string; context_window?: number };

export interface ToolsetConfig {
  type: 'agent_toolset_20260401';
  enabled_tools: string[];
}

export interface QoderAgent {
  id: string;
  name: string;
  model: AgentModelRef;
  system?: string | null;
  tools: ToolsetConfig[];
  version: number;
}

export interface QoderSession {
  id: string;
  status: string;
  agent: {
    id: string;
    name?: string;
    model: { id: string; effective_context_window?: number } | string;
    system?: string | null;
    tools?: ToolsetConfig[];
    version?: number;
  };
  environment_id: string;
  stats?: { active_seconds?: number; duration_seconds?: number };
}

export interface QoderFile {
  id: string;
  filename: string;
  size_bytes: number;
  mime_type: string;
  downloadable: boolean;
}

export type QoderImageSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string }
  | { type: 'file'; file_id: string };

export type QoderContentBlock = { type: 'text'; text: string } | { type: 'image'; source: QoderImageSource };

export type QoderInputEvent =
  | { type: 'user.message'; content: QoderContentBlock[] }
  | { type: 'user.interrupt' }
  | { type: 'system.message'; content: { type: 'text'; text: string }[] };

/** A buffered event or a stream-only frame (event_start / event_delta). */
export interface QoderEvent {
  id?: string;
  type: string;
  processed_at?: string;
  [k: string]: unknown;
}

export interface QoderStreamFrame {
  /** SSE `id:` line (shared by event_start, event_delta and the final buffered event). */
  id?: string;
  /** SSE `event:` line. */
  event: string;
  data: QoderEvent;
}
