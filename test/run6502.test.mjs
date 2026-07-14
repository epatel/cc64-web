// Cycle-count sanity for the 6502 harness: hand-computed cases.
import assert from 'node:assert';
import { makeCpu, step } from '../tools/run6502.mjs';

function runAt(bytes, addr, steps) {
  const mem = new Uint8Array(0x10000);
  mem.set(bytes, addr);
  const c = makeCpu(mem);
  c.pc = addr;
  for (let i = 0; i < steps; i++) step(c);
  return c;
}

// LDX #5; loop: DEX; BNE loop  (no page cross on the branch)
// 2 + 5*DEX(2) + 4 taken BNE(3) + final BNE(2) = 2 + 10 + 12 + 2 = 26
{
  const c = runAt([0xa2, 0x05, 0xca, 0xd0, 0xfd], 0x1000, 1 + 5 + 5);
  assert.strictEqual(c.cycles, 26, 'countdown loop');
}

// branch page-cross: BNE from $10fd taken to $1080 (same page: fd+2=ff -> target $1080? )
// place BNE at $10fe so pc-after-operand = $1100, target $10c0 -> page cross: 2+1+1 = 4
{
  const mem = new Uint8Array(0x10000);
  mem[0x10fe] = 0xd0; mem[0x10ff] = 0xc0;   // BNE -64 -> $10c0
  const c = makeCpu(mem);
  c.z = 0;
  c.pc = 0x10fe;
  step(c);
  assert.strictEqual(c.pc, 0x10c0);
  assert.strictEqual(c.cycles, 4, 'branch taken across page');
}

// LDA abs,X page cross: LDA $10FF,X with X=1 -> 4+1 = 5
{
  const mem = new Uint8Array(0x10000);
  mem.set([0xbd, 0xff, 0x10], 0x2000);
  const c = makeCpu(mem);
  c.x = 1;
  c.pc = 0x2000;
  step(c);
  assert.strictEqual(c.cycles, 5, 'lda abs,x page cross');
}

// LDA abs,X without cross -> 4; STA abs,X always 5
{
  const mem = new Uint8Array(0x10000);
  mem.set([0xbd, 0x00, 0x10, 0x9d, 0x00, 0x10], 0x2000);
  const c = makeCpu(mem);
  c.x = 1;
  c.pc = 0x2000;
  step(c);
  assert.strictEqual(c.cycles, 4, 'lda abs,x no cross');
  step(c);
  assert.strictEqual(c.cycles, 9, 'sta abs,x fixed 5');
}

// JSR+RTS = 6+6, INC zp = 5
{
  const mem = new Uint8Array(0x10000);
  mem.set([0x20, 0x00, 0x30], 0x2000);  // JSR $3000
  mem.set([0xe6, 0x10, 0x60], 0x3000);  // INC $10; RTS
  const c = makeCpu(mem);
  c.pc = 0x2000;
  step(c); step(c); step(c);
  assert.strictEqual(c.cycles, 17, 'jsr/inc/rts');
  assert.strictEqual(c.pc, 0x2003);
}

console.log('run6502 cycle tests passed');
