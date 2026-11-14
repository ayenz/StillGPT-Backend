/** Tiny but structurally valid media files generated in code (no fixtures on disk). */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A solid-colour RGB PNG of the given size (keep it small; default 2x2). */
export function makePng(width = 2, height = 2, rgb: [number, number, number] = [255, 128, 0]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  // compression, filter, interlace = 0
  const row = Buffer.alloc(1 + width * 3); // leading 0 = filter "None"
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function mp4Box(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, payload]);
}

/** A fake MP4: a real `ftyp` box followed by `free` and a dummy `mdat` (not playable, but sniffable). */
export function makeMp4(): Buffer {
  const ftyp = mp4Box(
    'ftyp',
    Buffer.concat([
      Buffer.from('isom', 'ascii'),
      Buffer.from([0, 0, 2, 0]), // minor version 512
      Buffer.from('isomiso2avc1mp41', 'ascii'),
    ]),
  );
  return Buffer.concat([ftyp, mp4Box('free', Buffer.alloc(0)), mp4Box('mdat', Buffer.alloc(64, 0x42))]);
}
