'use strict';

/**
 * Check that a buffer is a structurally valid JPEG and read its size.
 * The admin page re-encodes every photo to JPEG in the browser (which also strips
 * location data); the server only accepts files that really are JPEGs.
 */
function inspectJpeg(buffer) {
  if (!buffer || buffer.length < 128) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) return null;
  if (buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) return null;
  let i = 2;
  while (i + 4 <= buffer.length) {
    if (buffer[i] !== 0xff) { i += 1; continue; }
    const marker = buffer[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9) break;
    const length = buffer.readUInt16BE(i + 2);
    if (length < 2) return null;
    // Start-of-frame markers carry the image size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > buffer.length) return null;
      const height = buffer.readUInt16BE(i + 5);
      const width = buffer.readUInt16BE(i + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + length;
  }
  return null;
}

module.exports = { inspectJpeg };
