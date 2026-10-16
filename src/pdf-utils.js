/** PDF / PNG magic-byte helpers for carrier documents. */

export function isPdfBytes(bytes) {
  return (
    Boolean(bytes) &&
    bytes.length >= 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  );
}

export function isPngBytes(bytes) {
  return (
    Boolean(bytes) &&
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

/**
 * @param {unknown} b64
 * @returns {{ bytes: Buffer, ext: 'pdf' | 'png' } | null}
 */
export function decodeDocumentBase64(b64) {
  if (typeof b64 !== 'string' || b64.length < 80) return null;
  let bytes;
  try {
    bytes = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
  } catch {
    return null;
  }
  if (bytes.length < 100) return null;
  if (isPdfBytes(bytes)) return { bytes, ext: 'pdf' };
  if (isPngBytes(bytes)) return { bytes, ext: 'png' };
  return null;
}
