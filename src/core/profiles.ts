/** A profile = the tool set of a Qoder agent. Model and system prompt are applied per session. */
export type ProfileName = 'chat' | 'assistant' | 'image' | 'video' | 'research';

export interface Profile {
  name: ProfileName;
  tools: string[];
  system: string;
}

const BASE_SYSTEM =
  'You are a helpful assistant inside a chat app. Reply in the language the user writes in. Use Markdown when it helps readability.';

export const PROFILES: Record<ProfileName, Profile> = {
  chat: { name: 'chat', tools: [], system: BASE_SYSTEM },
  assistant: {
    name: 'assistant',
    tools: ['Read', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'ImageSearch', 'ImageGen', 'VideoGen', 'DeliverArtifacts'],
    system:
      BASE_SYSTEM +
      ' User attachments are mounted under /data/attachments/. When you create an image, video or file for the user, always deliver it with DeliverArtifacts.' +
      ' Only generate a video when the user explicitly asks for one.',
  },
  image: {
    name: 'image',
    tools: ['ImageGen', 'DeliverArtifacts', 'Read', 'Glob'],
    system:
      'You are an image generation backend. For each request call ImageGen exactly once with the given parameters, then deliver the result with DeliverArtifacts. Never ask questions. Reply with one short sentence.',
  },
  research: {
    name: 'research',
    tools: ['WebSearch', 'WebFetch', 'Bash', 'Read', 'Glob', 'Grep', 'DeliverArtifacts'],
    system:
      'You are a meticulous research agent working inside a research pipeline. Search broadly, open and read the actual sources, prefer primary, official and recent ones, and cross-check important facts.' +
      ' Never invent facts, numbers, quotes or URLs: every claim you report must come from a page you opened (or from a file under /data/attachments/). Never ask questions. When the task asks for JSON, your final message must be only that JSON.',
  },
  video: {
    name: 'video',
    tools: ['VideoGen', 'DeliverArtifacts', 'Read', 'Glob'],
    system:
      'You are a video generation backend. For each request call VideoGen exactly once with the given parameters, then deliver the MP4 with DeliverArtifacts. Never ask questions. Reply with one short sentence.',
  },
};

/** Tools a turn needs when the user attached documents (the sandbox must be able to read them). */
export const DOCUMENT_TOOLS = ['Read', 'Bash', 'Glob', 'Grep'];

export function isProfileName(v: unknown): v is ProfileName {
  return typeof v === 'string' && v in PROFILES;
}
