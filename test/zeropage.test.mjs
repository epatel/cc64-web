// 'zeropage' storage class (cc64-web extension): file-scope vars allocated
// in $57..$70, addressed with zero-page opcodes. Verifies allocation order,
// emitted opcodes, execution semantics on the 6502 harness (incl. the
// shortened branch offsets around zp inc/dec), and the error paths.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { compile } from '../src/compile.js';
import { ZP_POOL_FIRST } from '../src/parser.js';
import { run } from '../tools/run6502.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fs = new Map();
for (const f of readdirSync(join(root, 'assets/rt'))) {
  const raw = readFileSync(join(root, 'assets/rt', f));
  fs.set(f, /\.(h|c)$/.test(f) ? raw.toString('latin1') : new Uint8Array(raw));
}
const cc = (source) => compile({ source, fileName: 'zp.c', fs });

const HEAD = '#include "rt-c64-08-9f.h"\n';

// ---- semantics: run a program that exercises zp vars every way ----
{
  const res = cc(HEAD + `
zeropage int za, zb;
zeropage char zc;
zeropage int zarr[3];
int out0 *= 0x3000;
int out1 *= 0x3002;
int out2 *= 0x3004;
int out3 *= 0x3006;
int out4 *= 0x3008;

main()
{
  za = 1000;
  zb = -250;
  zc = 'a';
  za = za + zb;      /* 750 */
  ++za;              /* .incr.s on zp (shortened bne) */
  --zb;              /* .decr.s on zp */
  zarr[0] = 3; zarr[1] = 4; zarr[2] = 5;
  out0 = za;         /* 751 */
  out1 = zc;         /* 'a' = PETSCII 65 */
  out2 = zarr[0] + zarr[1] + zarr[2];   /* 12 */
  out3 = zb;         /* -251 */
  out4 = &za;        /* pool base */
}
`);
  assert.deepStrictEqual(res.diagnostics, [], 'clean compile');
  const { mem, done, idle } = run(res.prg, { maxSteps: 5e6 });
  assert.ok(done && !idle, 'ran to completion');
  const w = (a) => mem[a] | (mem[a + 1] << 8);
  assert.strictEqual(w(0x3000), 751, 'int arithmetic + zp increment');
  assert.strictEqual(w(0x3002), 65, 'zp char load clears high byte');
  assert.strictEqual(w(0x3004), 12, 'zp array via pointer indexing');
  assert.strictEqual(w(0x3006), (-251) & 0xffff, 'zp decrement');
  assert.strictEqual(w(0x3008), ZP_POOL_FIRST, '&zpvar = pool base');
  // allocation order: za $57/58, zb $59/5a, zc $5b, zarr $5c..$61
  const bytes = res.prg;
  const hasSeq = (...seq) => {
    outer: for (let i = 0; i + seq.length <= bytes.length; i++) {
      for (let j = 0; j < seq.length; j++) if (bytes[i + j] !== seq[j]) continue outer;
      return true;
    }
    return false;
  };
  assert.ok(hasSeq(0x85, 0x57, 0x86, 0x58), 'sta/stx zp for first int');
  assert.ok(hasSeq(0x85, 0x5b), 'sta zp for the char');
  assert.ok(hasSeq(0xe6, 0x57, 0xd0, 0x02, 0xe6, 0x58), 'zp inc with 2-byte branch skip');
  console.log('ok: zeropage semantics + opcodes (6502 harness)');
}

// ---- explicit *= placement below $100 also gets zp addressing ----
{
  const res = cc(HEAD + `
int zx *= 0x02;
int out0 *= 0x3000;
main() { zx = 4242; out0 = zx; }
`);
  assert.deepStrictEqual(res.diagnostics, [], 'clean compile');
  const { mem, done } = run(res.prg, { maxSteps: 1e6 });
  assert.ok(done, 'ran');
  assert.strictEqual(mem[0x3000] | (mem[0x3001] << 8), 4242);
  assert.strictEqual(mem[0x02] | (mem[0x03] << 8), 4242, 'lives at $02');
  console.log('ok: *= placement below $100 uses zp addressing');
}

// ---- error paths ----
{
  const res = cc(HEAD + 'zeropage int big[20];\nmain() {}\n');
  assert.ok(res.diagnostics.some((d) => /pool full/.test(d)), 'pool overflow diagnosed');
  console.log('ok: pool-full diagnostic');
}
{
  const res = cc(HEAD + 'zeropage int x = 1;\nmain() {}\n');
  assert.ok(res.diagnostics.some((d) => /no initializer/.test(d)), 'initializer rejected');
  console.log('ok: initializer diagnostic');
}
{
  const res = cc(HEAD + 'zeropage int f() { return 1; }\nmain() {}\n');
  assert.ok(res.diagnostics.some((d) => /variables only/.test(d)), 'function rejected');
  console.log('ok: zeropage function diagnostic');
}

console.log('zeropage tests passed');
