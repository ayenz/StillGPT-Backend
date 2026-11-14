/**
 * Normalized turn events — the single internal format every API surface renders from
 * (native SSE, OpenAI chunks, Anthropic stream events).
 */

export interface Artifact {
  /** Our file id (file_…). */
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'video' | 'audio' | 'file';
  /** Signed, time-limited URL that works without auth headers (<img>/<video>). */
  url: string;
  /** Small WebP (fits 400px; a still frame for videos) for gallery tiles. null when the type has none. */
  thumbnailUrl?: string | null;
  /** Medium WebP (fits 1280px; a still frame / poster for videos). null when the type has none. */
  previewUrl?: string | null;
}

export interface Credits {
  model: number;
  sandbox: number;
  total: number;
}

export type StopReason = 'end_turn' | 'interrupted' | 'budget_exceeded' | 'requires_action' | 'error';

export type TurnEvent =
  | { type: 'turn.started'; conversationId: string; messageId: string; model: string }
  | { type: 'model.fallback'; requested: string; resolved: string; reason: string }
  | { type: 'thinking' }
  | { type: 'text.delta'; text: string }
  | { type: 'text.completed'; text: string }
  | { type: 'tool.started'; id: string; name: string; input: unknown }
  | { type: 'tool.completed'; id: string; isError: boolean; output: string }
  | { type: 'artifact'; artifact: Artifact }
  | { type: 'usage'; credits: Credits }
  | { type: 'conversation.title'; conversationId: string; title: string }
  | { type: 'turn.completed'; messageId: string; stopReason: StopReason; text: string; artifacts: Artifact[]; credits: Credits }
  | { type: 'error'; code: string; message: string; retryable: boolean };

export const zeroCredits = (): Credits => ({ model: 0, sandbox: 0, total: 0 });

export function artifactKind(mimeType: string): Artifact['kind'] {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
}
