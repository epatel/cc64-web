// __asm { } inline assembly (cc64-web extension): byte-pins for every
// addressing mode, symbol/label/fixup resolution, and an end-to-end run
// mixing C and asm on the 6502 harness.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { assembleBlock } from '../src/asmblock.js';
import { CodeBuffer } from '../src/vasm.js';
import { compile } from '../src/compile.js';
import { run } from '../tools/run6502.mjs';

// ---- unit: assemble against a fake symbol table, pin the bytes ----
function asm(text, symbols = {}, origin = 0x2000) {
  const code = new CodeBuffer(origin);
  const errors = [];
  assembleBlock(
    text.split('\n').map((t, i) => ({ text: t, line: i + 1 })),
    { code, resolve: (n) => symbols[n] ?? null, error: (m) => errors.push(m) },
  );
  return { bytes: [...code.toBytes()], errors };
}

{
  const { bytes, errors } = asm(`
    lda #$41        ; imm
    lda $57         ; zp (auto)
    lda $c800       ; abs
    lda $c800,y     ; abs,y
    lda tab,x       ; abs,x via symbol
    lda (ptr),y     ; (zp),y via symbol
    sta v+1         ; symbol + offset, zp
    asl a
    ldy #<tab
    ldx #>tab
    inc $57
    rts
  `, { tab: 0xc800, ptr: 0xfb, v: 0x57 });
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(bytes, [
    0xa9, 0x41,
    0xa5, 0x57,
    0xad, 0x00, 0xc8,
    0xb9, 0x00, 0xc8,
    0xbd, 0x00, 0xc8,
    0xb1, 0xfb,
    0x85, 0x58,
    0x0a,
    0xa0, 0x00,
    0xa2, 0xc8,
    0xe6, 0x57,
    0x60,
  ]);
  console.log('ok: addressing-mode byte pins');
}

{
  // labels: backward + forward branches, self-modify patch, .byte/.word
  const { bytes, errors } = asm(`
  top:
    dex
    bne top         ; backward rel
    beq done        ; forward rel
    sta patch+1     ; forward abs into an operand
  patch:
    lda $ffff
  done:
    rts
    .byte 1, $02, three
    .word done, $1234
  `, { three: 3 });
  assert.deepStrictEqual(errors, []);
  const O = 0x2000;
  assert.deepStrictEqual(bytes, [
    0xca,
    0xd0, 0xfd,                    // bne top: back 3
    0xf0, 0x06,                    // beq done: over sta(3)+lda(3)
    0x8d, (O + 9) & 0xff, (O + 9) >> 8,   // sta patch+1
    0xad, 0xff, 0xff,
    0x60,
    1, 2, 3,
    (O + 11) & 0xff, (O + 11) >> 8, 0x34, 0x12,
  ]);
  console.log('ok: labels, branches, fixups, data directives');
}

{
  const { errors } = asm('bogus $12\n lda ($1234),y\n bne faraway');
  assert.strictEqual(errors.length, 3, `three diagnostics: ${errors}`);
  assert.match(errors[0], /unknown instruction/);
  assert.match(errors[1], /bad \(zp\),y/);
  assert.match(errors[2], /undefined symbol/);
  console.log('ok: error diagnostics');
}

// ---- end-to-end: C + __asm, executed on the harness ----
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fs = new Map();
for (const f of readdirSync(join(root, 'assets/rt'))) {
  const raw = readFileSync(join(root, 'assets/rt', f));
  fs.set(f, /\.(h|c)$/.test(f) ? raw.toString('latin1') : new Uint8Array(raw));
}
{
  const res = compile({ fileName: 'a.c', fs, source: `#include "rt-c64-08-9f.h"
#define MAGIC 40
__zeropage int zv;
int out0 *= 0x3000;
int out1 *= 0x3002;

main()
{
  zv = 2;
  __asm {
    lda zv          ; C zeropage global, zp addressing
    clc
    adc #MAGIC      ; #define constant
    sta zv
    ldx #0
  loop:             ; local label, backward branch
    inx
    cpx #10
    bne loop
    stx zv+1        ; hi byte of the int
  }
  out0 = zv;        /* 42 + (10 << 8) */
  __asm {
    lda #<out1      ; self-modifying: patch the operand below
    sta smc+1
    lda #>out1
    sta smc+2
    lda #99
  smc:
    sta $ffff
  }
}
` });
  assert.deepStrictEqual(res.diagnostics, [], 'clean compile');
  const { mem, done } = run(res.prg, { maxSteps: 1e6 });
  assert.ok(done, 'ran');
  assert.strictEqual(mem[0x3000] | (mem[0x3001] << 8), 42 + (10 << 8), 'asm wrote through C zp var');
  assert.strictEqual(mem[0x3002], 99, 'self-modifying store hit the patched address');
  console.log('ok: C + __asm end-to-end on the 6502 harness');
}
{
  const res = compile({ fileName: 'a.c', fs, source: `#include "rt-c64-08-9f.h"
int out0 *= 0x3000;
main() { out0 = 7; __asm { inc $3000 } out0 = out0 + 1; }
` });
  assert.deepStrictEqual(res.diagnostics, [], 'single-line block compiles');
  const { mem, done } = run(res.prg, { maxSteps: 1e6 });
  assert.ok(done, 'ran');
  assert.strictEqual(mem[0x3000], 9, 'C, asm, C on one line all executed');
  console.log('ok: single-line block');
}

console.log('asmblock tests passed');
