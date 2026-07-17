// '__sprite' data blocks (cc64-web extension): 21 raw pixel rows compiled
// into a 64-byte char array (63 bytes sprite data + 1 pad). Verifies hires
// and multicolor encodings end-to-end on the 6502 harness (the runtime's
// init stream has to land the bytes in memory), the array/pointer typing,
// and the error paths.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { compile } from '../src/compile.js';
import { parseSpriteRows } from '../src/sprite.js';
import { run } from '../tools/run6502.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fs = new Map();
for (const f of readdirSync(join(root, 'assets/rt'))) {
  const raw = readFileSync(join(root, 'assets/rt', f));
  fs.set(f, /\.(h|c)$/.test(f) ? raw.toString('latin1') : new Uint8Array(raw));
}
const cc = (source) => compile({ source, fileName: 'sprite.c', fs });

const HEAD = '#include "rt-c64-08-9f.h"\n';

const HIRES_ROW = '........ ..xxxx.. ........';
const hiresRows = Array.from({ length: 21 }, (_, i) =>
  i === 0 ? 'x.......  ........  .......x' : HIRES_ROW).join('\n');

// ---- semantics: hires sprite lands in memory, symbol is a char array ----
{
  const res = cc(HEAD + `
__sprite balloon = {
${hiresRows}
};
int out0 *= 0x3000;
int out1 *= 0x3002;
int out2 *= 0x3004;
int out3 *= 0x3006;
main()
{
  char *p;
  p = balloon;
  out0 = 0 + p[0];         /* row 0: x....... = $80 */
  out1 = 0 + p[2];         /* row 0: .......x = $01 */
  out2 = 0 + balloon[4];   /* row 1: ..xxxx.. = $3c */
  out3 = 0 + p[63];        /* pad byte = 0 */
}
`);
  assert.deepStrictEqual(res.diagnostics, [], 'clean compile');
  const { mem, done, idle } = run(res.prg, { maxSteps: 5e6 });
  assert.ok(done && !idle, 'ran to completion');
  const w = (a) => mem[a] | (mem[a + 1] << 8);
  assert.strictEqual(w(0x3000), 0x80, 'row 0 byte 0');
  assert.strictEqual(w(0x3002), 0x01, 'row 0 byte 2');
  assert.strictEqual(w(0x3004), 0x3c, 'row 1 byte 1 via array indexing');
  assert.strictEqual(w(0x3006), 0x00, 'pad byte 63 is zero');
  console.log('ok: __sprite hires semantics (6502 harness)');
}

// ---- encoding: multicolor pairs and hires bits (unit level) ----
{
  const mk = (rows) => rows.map((text, i) => ({ text, line: i + 1 }));
  const mc = parseSpriteRows(mk([
    '.-ox .... ....',
    ...Array.from({ length: 20 }, () => '.... .... ....'),
  ]));
  // .-ox = 00 01 10 11 = $1b
  assert.strictEqual(mc[0], 0x1b, 'multicolor pair packing');
  assert.strictEqual(mc.length, 64, '64 bytes');
  assert.strictEqual(mc[63], 0, 'pad byte');

  const hi = parseSpriteRows(mk([
    'xxxxxxxx ........ x.x.x.x.',
    ...Array.from({ length: 20 }, () => '........ ........ ........'),
  ]));
  assert.deepStrictEqual([...hi.slice(0, 3)], [0xff, 0x00, 0xaa], 'hires bit packing');

  // comments and blank lines are ignored
  const withComments = parseSpriteRows(mk([
    '',
    '// a balloon',
    ...Array.from({ length: 21 }, () => '........ ........ ........ ; row'),
  ]));
  assert.strictEqual(withComments[0], 0, 'comment rows ignored');
  console.log('ok: __sprite encodings (hires bits, multicolor pairs, comments)');
}

// ---- error paths ----
{
  const bad = (src, re, what) => {
    const res = cc(HEAD + src);
    assert.ok(res.diagnostics.some((d) => re.test(d)),
      `${what}: expected ${re}, got ${JSON.stringify(res.diagnostics)}`);
  };
  bad(`__sprite s = {\n${HIRES_ROW}\n};\nmain(){}`, /21 rows expected, got 1/, 'row count');
  bad(`__sprite s = {\n${Array.from({ length: 21 }, () => '....xx').join('\n')}\n};\nmain(){}`,
    /row width must be 24/, 'row width');
  bad(`__sprite s = {\n${Array.from({ length: 21 }, () => '........ ..q..... ........').join('\n')}\n};\nmain(){}`,
    /bad pixel 'q'/, 'bad pixel char');
  bad(`__sprite s = {\n${'........ .....o.. ........\n'.repeat(21)}};\nmain(){}`,
    /bad pixel 'o'/, 'multicolor char in hires row');
  bad(`main() { __sprite s; }`, /file scope only/, 'statement position');
  console.log('ok: __sprite error paths');
}
