/** A profile = the tool set of a Qoder agent. Model and system prompt are applied per session. */
export type ProfileName = 'chat' | 'assistant' | 'image' | 'video';

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
