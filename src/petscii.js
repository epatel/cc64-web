// ASCII <-> PETSCII conversion, ported from pzembrod/cc64 tools/petscii.c.
// cc64 reads C sources as PETSCII SEQ files and writes logs in PETSCII.

export function ascii2petscii(c) {
  if (c >= 0x41 && c <= 0x5a) return c + 0x80;
  if (c >= 0x61 && c <= 0x7a) return c - 0x20;
  if (c >= 0x7b && c <= 0x7f) return c + 0x60;
  if (c === 0x0a) return 0x0d;
  if (c < 0x20) return 0x20;
  return c;
}

export function petscii2ascii(c) {
  if (c >= 0x41 && c <= 0x5a) return c + 0x20;
  if (c >= 0x61 && c <= 0x7a) return c - 0x20;
  if (c >= 0xc0 && c <= 0xda) return c - 0x80;
  if (c >= 0xdb && c <= 0xdf) return c - 0x60;
  if (c === 0x0d) return 0x0a;
  if (c === 0xa4) return 0x5f; // '_', only for cc64 forth sources
  if (c < 0x20) return 0x20;
  return c;
}

export function textToPetscii(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = ascii2petscii(text.charCodeAt(i));
  return out;
}

export function petsciiToText(bytes) {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(petscii2ascii(b));
  return out;
}
