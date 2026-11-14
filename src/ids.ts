import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Random base36 string; 16 chars ≈ 82 bits. */
export function randomId(length = 16): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

/** Prefixed ids make logs and API payloads self-describing: conv_…, msg_…, file_…. */
export const newId = (prefix: string) => `${prefix}_${randomId()}`;

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
