import type { ContentBlock } from '../db/schema.js';
import { AppError } from '../errors.js';
import type { QoderClient } from '../qoder/client.js';
import type { QoderContentBlock } from '../qoder/types.js';
import type { MediaStore, StoredFile } from './storage.js';

/** Base64 inline limit is 10 MiB of encoded text → ~7.5 MB raw; stay below with margin. */
const INLINE_IMAGE_MAX = 7 * 1024 * 1024;
/** Qoder POST /files accepts ~5 MB. */
export const UPLOAD_MAX = 5 * 1024 * 1024;
export const ATTACHMENT_DIR = '/data/attachments';

export const INLINE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export interface PreparedInput {
  content: QoderContentBlock[];
  /** Files to mount into the session before sending (mount path → qoder file id). */
  mounts: { qoderFileId: string; mountPath: string }[];
  hasDocuments: boolean;
}

/**
 * Converts our stored content blocks into a Qoder user.message.
 * Images go inline (base64) or via Qoder file id when large; documents are uploaded and mounted
 * under /data/attachments/ with a text note telling the agent where they are.
 */
export async function prepareInput(blocks: ContentBlock[], store: MediaStore, qoder: QoderClient, userId: string): Promise<PreparedInput> {
  const content: QoderContentBlock[] = [];
  const mounts: PreparedInput['mounts'] = [];
  const notes: string[] = [];
  const usedPaths = new Set<string>();

  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.trim()) content.push({ type: 'text', text: block.text });
      continue;
    }
    const file = await store.get(block.fileId, userId);
    if (block.type === 'image' && INLINE_IMAGE_TYPES.includes(file.mimeType)) {
      if (file.size <= INLINE_IMAGE_MAX) {
        const data = (await store.read(file)).toString('base64');
        content.push({ type: 'image', source: { type: 'base64', media_type: file.mimeType, data } });
      } else {
        content.push({ type: 'image', source: { type: 'file', file_id: await ensureUploaded(file, store, qoder) } });
      }
      continue;
    }
    // documents (and images in formats the vision input does not accept) → sandbox files
    const mountPath = uniquePath(`${ATTACHMENT_DIR}/${file.filename}`, usedPaths);
    mounts.push({ qoderFileId: await ensureUploaded(file, store, qoder), mountPath });
    notes.push(`- ${mountPath} (${file.mimeType}, ${file.size} bytes)`);
  }

  if (notes.length) {
    content.unshift({ type: 'text', text: `[Attached files available in your sandbox]\n${notes.join('\n')}` });
  }
  if (!content.some((b) => b.type === 'text' || b.type === 'image')) throw new AppError(400, 'empty_message', 'Message has no content');
  return { content, mounts, hasDocuments: mounts.length > 0 };
}

async function ensureUploaded(file: StoredFile, store: MediaStore, qoder: QoderClient): Promise<string> {
  if (file.qoderFileId) return file.qoderFileId;
  if (file.size > UPLOAD_MAX) {
    throw new AppError(413, 'attachment_too_large', `${file.filename} is ${(file.size / 1e6).toFixed(1)} MB; documents are limited to 5 MB`);
  }
  const uploaded = await qoder.uploadFile(await store.read(file), file.filename, file.mimeType);
  await store.setQoderFileId(file.id, uploaded.id);
  return uploaded.id;
}

function uniquePath(path: string, used: Set<string>): string {
  let candidate = path;
  for (let i = 2; used.has(candidate); i++) candidate = path.replace(/(\.[^./]+)?$/, `-${i}$1`);
  used.add(candidate);
  return candidate;
}
