import sharp from 'sharp';
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
/** Still images we can shrink for the upstream copy (GIFs may be animated, so they are sent as they are). */
export const SHRINKABLE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
/** Target size of a shrunk upstream copy, safely under UPLOAD_MAX. */
const UPSTREAM_IMAGE_TARGET = Math.floor(4.5 * 1024 * 1024);
const canShrink = (f: StoredFile) => SHRINKABLE_IMAGE_TYPES.includes(f.mimeType);

export interface PreparedInput {
  content: QoderContentBlock[];
  /** Files to mount into the session before sending (mount path → qoder file id). */
  mounts: { fileId: string; qoderFileId: string; mountPath: string }[];
  hasDocuments: boolean;
}

/**
 * Converts our stored content blocks into a Qoder user.message.
 * Images go inline (base64) or via Qoder file id when large; documents are uploaded and mounted
 * under /data/attachments/ with a text note telling the agent where they are.
 */
export async function prepareInput(
  blocks: ContentBlock[],
  store: MediaStore,
  qoder: QoderClient,
  userId: string,
  opts: { mountImages?: boolean } = {},
): Promise<PreparedInput> {
  const content: QoderContentBlock[] = [];
  const mounts: PreparedInput['mounts'] = [];
  const notes: string[] = [];
  const usedPaths = new Set<string>();
  let hasDocuments = false;

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
      // Vision input only lets the model *see* the image; tools (ImageGen edits, Read, Bash) need a real file.
      if (opts.mountImages && (file.size <= UPLOAD_MAX || canShrink(file))) {
        const mountPath = uniquePath(`${ATTACHMENT_DIR}/${file.filename}`, usedPaths);
        mounts.push({ fileId: file.id, qoderFileId: await ensureUploaded(file, store, qoder), mountPath });
        notes.push(`- ${mountPath} (${file.mimeType}, ${file.size} bytes; the image shown above)`);
      }
      continue;
    }
    // documents (and images in formats the vision input does not accept) → sandbox files
    hasDocuments = true;
    const mountPath = uniquePath(`${ATTACHMENT_DIR}/${file.filename}`, usedPaths);
    mounts.push({ fileId: file.id, qoderFileId: await ensureUploaded(file, store, qoder), mountPath });
    notes.push(`- ${mountPath} (${file.mimeType}, ${file.size} bytes)`);
  }

  if (notes.length) {
    content.unshift({ type: 'text', text: `[Attached files available in your sandbox]\n${notes.join('\n')}` });
  }
  if (!content.some((b) => b.type === 'text' || b.type === 'image')) throw new AppError(400, 'empty_message', 'Message has no content');
  return { content, mounts, hasDocuments };
}

/**
 * Upload `file` again after Qoder lost our cached copy (404: deleted upstream, or uploaded under a previous
 * credential/account). Returns the new Qoder file id.
 */
export async function reupload(fileId: string, userId: string, store: MediaStore, qoder: QoderClient): Promise<string> {
  await store.setQoderFileId(fileId, null);
  const file = await store.get(fileId, userId);
  return ensureUploaded({ ...file, qoderFileId: null }, store, qoder);
}

async function ensureUploaded(file: StoredFile, store: MediaStore, qoder: QoderClient): Promise<string> {
  if (file.qoderFileId) return file.qoderFileId;
  let bytes = await store.read(file);
  if (bytes.length > UPLOAD_MAX && canShrink(file)) bytes = await shrinkImage(bytes, file.mimeType);
  if (bytes.length > UPLOAD_MAX) {
    throw new AppError(413, 'attachment_too_large', `${file.filename} is ${(file.size / 1e6).toFixed(1)} MB; documents are limited to 5 MB`);
  }
  const uploaded = await qoder.uploadFile(bytes, file.filename, file.mimeType);
  await store.setQoderFileId(file.id, uploaded.id);
  return uploaded.id;
}

/**
 * A smaller copy of a large image for Qoder (which takes ~5 MB per file): same format, so the file name and type
 * stay right, scaled down step by step until it fits. The stored original is untouched.
 */
export async function shrinkImage(bytes: Buffer, mimeType: string, target = UPSTREAM_IMAGE_TARGET): Promise<Buffer> {
  // decode once (capped at 4096 px), then re-encode from the raw pixels; the next size is estimated from the last result
  const { data, info } = await sharp(bytes, { limitInputPixels: false })
    .rotate()
    .resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const raw = { width: info.width, height: info.height, channels: info.channels };
  let edge = Math.max(info.width, info.height);
  let out = bytes;
  for (let attempt = 0; attempt < 5; attempt++) {
    const img = sharp(data, { raw }).resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true });
    out =
      mimeType === 'image/png'
        ? await img.png({ compressionLevel: 6 }).toBuffer()
        : mimeType === 'image/webp'
          ? await img.webp({ quality: 88 }).toBuffer()
          : await img.jpeg({ quality: 88, mozjpeg: true }).toBuffer();
    if (out.length <= target || edge <= 512) return out;
    // bytes scale roughly with pixel count
    edge = Math.max(512, Math.floor(edge * Math.sqrt(target / out.length) * 0.92));
  }
  return out;
}

function uniquePath(path: string, used: Set<string>): string {
  let candidate = path;
  for (let i = 2; used.has(candidate); i++) candidate = path.replace(/(\.[^./]+)?$/, `-${i}$1`);
  used.add(candidate);
  return candidate;
}
