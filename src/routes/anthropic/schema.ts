import { z } from 'zod';

/** Anthropic Messages API request shapes (the subset StillGPT understands; unknown fields are dropped). */

const base64Source = z.object({ type: z.literal('base64'), media_type: z.string(), data: z.string().min(1) });
const urlSource = z.object({ type: z.literal('url'), url: z.string().min(1) });
const textSource = z.object({ type: z.literal('text'), media_type: z.string().optional(), data: z.string() });
const contentSource = z.object({
  type: z.literal('content'),
  content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]),
});

const textBlock = z.object({ type: z.literal('text'), text: z.string() });
const imageBlock = z.object({ type: z.literal('image'), source: z.discriminatedUnion('type', [base64Source, urlSource]) });
const documentBlock = z.object({
  type: z.literal('document'),
  source: z.discriminatedUnion('type', [base64Source, urlSource, textSource, contentSource]),
  title: z.string().nullish(),
});
/** Reasoning blocks clients echo back in assistant history; they carry nothing we can replay. */
const thinkingBlock = z.object({ type: z.enum(['thinking', 'redacted_thinking']) });
/** Tool blocks are recognised only so we can reject them with a clear error (phase 2). */
const toolBlock = z.object({ type: z.enum(['tool_use', 'tool_result', 'server_tool_use']) });

export const contentBlock = z.discriminatedUnion('type', [textBlock, imageBlock, documentBlock, thinkingBlock, toolBlock]);

export type ContentBlockIn = z.infer<typeof contentBlock>;
export type ImageBlockIn = z.infer<typeof imageBlock>;
export type DocumentBlockIn = z.infer<typeof documentBlock>;
export type FileBlockIn = ImageBlockIn | DocumentBlockIn;

export const message = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(contentBlock)]),
});
export type MessageIn = z.infer<typeof message>;

const system = z.union([z.string(), z.array(textBlock)]);

const common = {
  model: z.string().min(1),
  system: system.optional(),
  messages: z.array(message).min(1),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
};

export const countTokensRequest = z.object(common);
export type CountTokensRequest = z.infer<typeof countTokensRequest>;

export const messagesRequest = z.object({
  ...common,
  max_tokens: z.number().int().positive(),
  stream: z.boolean().optional(),
  metadata: z
    .object({
      user_id: z.string().nullish(),
      /** StillGPT extension: pin the call to a conversation. */
      conversation_id: z.string().nullish(),
    })
    .optional(),
  // Accepted for compatibility; Qoder agents do not expose sampling controls.
  temperature: z.number().optional(),
  top_k: z.number().optional(),
  top_p: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  thinking: z.unknown().optional(),
});
export type MessagesRequest = z.infer<typeof messagesRequest>;
