// __sprite blocks (cc64-web extension; real cc64 rejects the keyword):
//
//   __sprite balloon = {
//     ........ ..xxxx.. ........
//     ...                          (21 rows)
//   };
//
// declares a file-scope char array of 64 bytes: 63 bytes of C64 sprite
// data + one zero pad byte (hardware sprites are 63 bytes; sprite pointers
// count in 64-byte blocks). Rows are raw source lines (no PETSCII, no C
// tokens); whitespace inside a row is visual grouping and is ignored, and
// `//` or `;` start a comment to end of line.
//
// hires (24 pixels/row):    `.` = 0 (transparent), `x` = 1 (sprite color)
// multicolor (12 pairs/row): `.` = 00 (transparent)
//                            `-` = 01 (shared multicolor $d025)
//                            `o` = 10 (the sprite's own color $d027+n)
//                            `x` = 11 (shared multicolor $d026)
//
// The mode is chosen by row width (24 = hires, 12 = multicolor); all rows
// must be the same width. Bits are packed MSB-first, 3 bytes per row.

export const SPRITE_ROWS = 21;
export const SPRITE_BYTES = 64;            // 63 data + 1 pad

const MC_VALUE = { '.': 0, '-': 1, o: 2, x: 3 };

export function parseSpriteRows(lines) {
  const rows = [];
  for (const { text, line } of lines) {
    const clean = text.replace(/(\/\/|;).*$/, '').replace(/\s+/g, '');
    if (clean) rows.push({ clean, line });
  }
  if (rows.length !== SPRITE_ROWS) {
    throw new Error(`${SPRITE_ROWS} rows expected, got ${rows.length}`);
  }
  const width = rows[0].clean.length;
  if (width !== 24 && width !== 12) {
    throw new Error(`row width must be 24 pixels (hires) or 12 pairs (multicolor), got ${width} (line ${rows[0].line})`);
  }
  const multicolor = width === 12;
  const ok = multicolor ? /^[.\-ox]+$/ : /^[.x]+$/;
  const bytes = new Uint8Array(SPRITE_BYTES);
  rows.forEach(({ clean, line }, r) => {
    if (clean.length !== width) {
      throw new Error(`row width ${clean.length} != ${width} (line ${line})`);
    }
    if (!ok.test(clean)) {
      const bad = clean.match(multicolor ? /[^.\-ox]/ : /[^.x]/)[0];
      throw new Error(`bad pixel '${bad}' (line ${line}${multicolor ? '' : "; hires rows use only . and x"})`);
    }
    let bits = 0;
    for (const c of clean) {
      bits = multicolor ? (bits << 2) | MC_VALUE[c] : (bits << 1) | (c === 'x' ? 1 : 0);
    }
    bytes[r * 3] = (bits >> 16) & 0xff;
    bytes[r * 3 + 1] = (bits >> 8) & 0xff;
    bytes[r * 3 + 2] = bits & 0xff;
  });
  return bytes;
}
