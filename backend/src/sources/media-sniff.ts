/**
 * Elfura Backend — Media Byte Sniffing (zero disk, bounded)
 * =========================================================
 * Some CDNs wrap MPEG-TS inside a 1×1 PNG container: the segment carries a
 * real PNG signature and an `IHDR` chunk, and the transport stream itself sits
 * in a private `tsDa` chunk. Serving or probing such a segment returns
 * `Content-Type: image/png`, which looks exactly like a broken stream (a
 * hot-link error image) unless the first bytes are inspected.
 *
 * This module classifies the leading bytes so callers can tell:
 *   - a genuine error/poster image  -> the stream is NOT playable
 *   - a PNG-wrapped transport chunk -> the stream IS playable (bytes must be
 *     unwrapped before the browser sees them)
 *
 * Everything here is pure and bounded: callers pass in at most a few KiB for
 * classification, and full segments are only unwrapped inside a hard cap.
 */

export type MediaSniff =
  | 'mpeg-ts'
  | 'png-wrapped-ts'
  | 'png-image'
  | 'jpeg-image'
  | 'gif-image'
  | 'webp-image'
  | 'mp4'
  | 'unknown';

/** PNG filesystem signature (8 bytes). */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Private chunk type used by the PNG-wrapped transport stream container. */
const TRANSPORT_CHUNK_TYPES = new Set(['tsda']);

function startsWithBytes(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

/** True when the buffer starts with the PNG signature. */
export function isPng(bytes: Uint8Array): boolean {
  return startsWithBytes(bytes, PNG_SIGNATURE);
}

/** True when the buffer starts with a JPEG SOI marker. */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** True when the buffer starts with an MPEG-TS sync byte (188-byte packets). */
export function isMpegTs(bytes: Uint8Array): boolean {
  if (bytes.length < 189) return bytes.length > 0 && bytes[0] === 0x47;
  return bytes[0] === 0x47 || bytes[188] === 0x47;
}

/** True when the buffer starts with an ISO-BMFF `ftyp` box. */
export function isMp4(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) === 'ftyp';
}

/**
 * Walk PNG chunk headers within `bytes` and report whether a transport-stream
 * chunk is present. Bounded: walks at most `maxChunks` headers and never reads
 * chunk payloads.
 */
export function pngCarriesTransportStream(bytes: Uint8Array, maxChunks = 8): boolean {
  if (!isPng(bytes)) return false;
  let offset = PNG_SIGNATURE.length;
  for (let chunk = 0; chunk < maxChunks; chunk += 1) {
    if (offset + 8 > bytes.length) return false;
    const length =
      ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    if (TRANSPORT_CHUNK_TYPES.has(type.toLowerCase())) return true;
    if (type === 'IEND') return false;
    // A chunk cannot be larger than the buffer we were handed; stop instead of
    // looping on a malformed header.
    if (length > 16 * 1024 * 1024) return false;
    offset += 12 + length;
    if (offset <= PNG_SIGNATURE.length) return false;
  }
  return false;
}

/** Classify the leading bytes of a media response. */
export function sniffMediaBytes(bytes: Uint8Array): MediaSniff {
  if (bytes.length === 0) return 'unknown';
  if (isMpegTs(bytes)) return 'mpeg-ts';
  if (isPng(bytes)) return pngCarriesTransportStream(bytes) ? 'png-wrapped-ts' : 'png-image';
  if (isJpeg(bytes)) return 'jpeg-image';
  if (startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38])) return 'gif-image';
  if (startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46])) return 'webp-image';
  if (isMp4(bytes)) return 'mp4';
  return 'unknown';
}

/**
 * Extract the transport stream payload from a PNG-wrapped segment.
 * Returns `null` when the buffer is not a PNG-wrapped TS or when the result
 * would exceed `maxBytes` (callers must then pass the original bytes through
 * untouched rather than risk unbounded memory).
 */
export function unwrapPngTransportStream(input: Uint8Array, maxBytes = 8 * 1024 * 1024): Uint8Array | null {
  if (!isPng(input)) return null;
  const parts: Uint8Array[] = [];
  let total = 0;
  let offset = PNG_SIGNATURE.length;
  let sawTransportChunk = false;
  while (offset + 8 <= input.length) {
    const length =
      ((input[offset] << 24) | (input[offset + 1] << 16) | (input[offset + 2] << 8) | input[offset + 3]) >>> 0;
    const type = String.fromCharCode(input[offset + 4], input[offset + 5], input[offset + 6], input[offset + 7]);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > input.length) break;
    if (TRANSPORT_CHUNK_TYPES.has(type.toLowerCase())) {
      sawTransportChunk = true;
      total += length;
      if (total > maxBytes) return null;
      parts.push(input.subarray(dataStart, dataEnd));
    }
    if (type === 'IEND') break;
    offset = dataEnd + 4; // skip CRC
    if (offset <= PNG_SIGNATURE.length) break;
  }
  if (!sawTransportChunk || parts.length === 0) return null;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  return out;
}

/** True when a `Content-Type` header should be treated as an image response. */
export function isImageContentType(contentType: string | null | undefined): boolean {
  return /^\s*image\//i.test(String(contentType ?? ''));
}
