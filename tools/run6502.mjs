// Minimal NMOS 6502 interpreter (documented opcodes) — an execution harness
// for cc64-web output: load a PRG into flat RAM, start at its BASIC stub's
// SYS target, run N instructions with REAL NMOS cycle counts (base cycles,
// page-cross and branch-taken penalties). No Kernal, no VIC — CPU + 64K RAM
// (fine for compute-style programs; Kernal calls would hit RTS-less ROM).
//
// Usage as lib: import { run } from './run6502.mjs'

export function makeCpu(mem) {
  const c = { a: 0, x: 0, y: 0, sp: 0xfd, pc: 0, n: 0, z: 1, cf: 0, v: 0, d: 0, i: 1, mem, cycles: 0, instructions: 0, writes: 0, px: 0 };
  return c;
}

const rd = (c, a) => c.mem[a & 0xffff];
const wr = (c, a, v) => { c.mem[a & 0xffff] = v & 0xff; c.writes++; };
const rd16 = (c, a) => rd(c, a) | (rd(c, a + 1) << 8);

function push(c, v) { wr(c, 0x100 + c.sp, v); c.sp = (c.sp - 1) & 0xff; }
function pop(c) { c.sp = (c.sp + 1) & 0xff; return rd(c, 0x100 + c.sp); }
const nz = (c, v) => { v &= 0xff; c.n = v >> 7; c.z = v === 0 ? 1 : 0; return v; };

function adc(c, m) {
  if (c.d) throw new Error('decimal mode not supported');
  const r = c.a + m + c.cf;
  c.v = (~(c.a ^ m) & (c.a ^ r) & 0x80) ? 1 : 0;
  c.cf = r > 0xff ? 1 : 0;
  c.a = nz(c, r);
}
function sbc(c, m) { adc(c, m ^ 0xff); }
function cmp(c, r, m) { const t = r - m; c.cf = t >= 0 ? 1 : 0; nz(c, t); }

// addressing modes return an address; 'imm' handled inline
function aZP(c) { return rd(c, c.pc++); }
function aZPX(c) { return (rd(c, c.pc++) + c.x) & 0xff; }
function aZPY(c) { return (rd(c, c.pc++) + c.y) & 0xff; }
function aABS(c) { const a = rd16(c, c.pc); c.pc += 2; return a; }
function aABSX(c) { const b = aABS(c); const a = (b + c.x) & 0xffff; c.px = (b ^ a) & 0xff00 ? 1 : 0; return a; }
function aABSY(c) { const b = aABS(c); const a = (b + c.y) & 0xffff; c.px = (b ^ a) & 0xff00 ? 1 : 0; return a; }
function aINDX(c) { const z = (rd(c, c.pc++) + c.x) & 0xff; return rd(c, z) | (rd(c, (z + 1) & 0xff) << 8); }
function aINDY(c) { const z = rd(c, c.pc++); const b = rd(c, z) | (rd(c, (z + 1) & 0xff) << 8); const a = (b + c.y) & 0xffff; c.px = (b ^ a) & 0xff00 ? 1 : 0; return a; }

function branch(c, cond) {
  const off = rd(c, c.pc++);
  if (cond) {
    const t = (c.pc + (off < 128 ? off : off - 256)) & 0xffff;
    c.cycles += 1 + (((c.pc ^ t) & 0xff00) ? 1 : 0);
    c.pc = t;
  }
}

function flags(c) {
  return (c.n << 7) | (c.v << 6) | 0x20 | (c.d << 3) | (c.i << 2) | (c.z << 1) | c.cf;
}
function setFlags(c, p) {
  c.n = (p >> 7) & 1; c.v = (p >> 6) & 1; c.d = (p >> 3) & 1;
  c.i = (p >> 2) & 1; c.z = (p >> 1) & 1; c.cf = p & 1;
}


// NMOS 6502 cycle counts (documented opcodes). Reads with abs,X / abs,Y /
// (zp),Y cost +1 when the index crosses a page; branches cost +1 when
// taken and +1 more when the target crosses a page.
const CYC = new Uint8Array(256);
{
  const set = (pairs) => { for (const [op, n] of pairs) CYC[op] = n; };
  set([[0xa9,2],[0xa5,3],[0xb5,4],[0xad,4],[0xbd,4],[0xb9,4],[0xa1,6],[0xb1,5], // LDA
       [0xa2,2],[0xa6,3],[0xb6,4],[0xae,4],[0xbe,4],                            // LDX
       [0xa0,2],[0xa4,3],[0xb4,4],[0xac,4],[0xbc,4],                            // LDY
       [0x85,3],[0x95,4],[0x8d,4],[0x9d,5],[0x99,5],[0x81,6],[0x91,6],          // STA
       [0x86,3],[0x96,4],[0x8e,4],[0x84,3],[0x94,4],[0x8c,4],                   // STX/STY
       [0xaa,2],[0xa8,2],[0x8a,2],[0x98,2],[0xba,2],[0x9a,2],                   // transfers
       [0x48,3],[0x68,4],[0x08,3],[0x28,4],                                     // stack
       [0x69,2],[0x65,3],[0x75,4],[0x6d,4],[0x7d,4],[0x79,4],[0x61,6],[0x71,5], // ADC
       [0xe9,2],[0xe5,3],[0xf5,4],[0xed,4],[0xfd,4],[0xf9,4],[0xe1,6],[0xf1,5], // SBC
       [0x29,2],[0x25,3],[0x35,4],[0x2d,4],[0x3d,4],[0x39,4],[0x21,6],[0x31,5], // AND
       [0x09,2],[0x05,3],[0x15,4],[0x0d,4],[0x1d,4],[0x19,4],[0x01,6],[0x11,5], // ORA
       [0x49,2],[0x45,3],[0x55,4],[0x4d,4],[0x5d,4],[0x59,4],[0x41,6],[0x51,5], // EOR
       [0xc9,2],[0xc5,3],[0xd5,4],[0xcd,4],[0xdd,4],[0xd9,4],[0xc1,6],[0xd1,5], // CMP
       [0xe0,2],[0xe4,3],[0xec,4],[0xc0,2],[0xc4,3],[0xcc,4],                   // CPX/CPY
       [0x24,3],[0x2c,4],                                                        // BIT
       [0xe6,5],[0xf6,6],[0xee,6],[0xfe,7],[0xc6,5],[0xd6,6],[0xce,6],[0xde,7], // INC/DEC
       [0xe8,2],[0xc8,2],[0xca,2],[0x88,2],
       [0x0a,2],[0x06,5],[0x16,6],[0x0e,6],[0x1e,7],                             // ASL
       [0x4a,2],[0x46,5],[0x56,6],[0x4e,6],[0x5e,7],                             // LSR
       [0x2a,2],[0x26,5],[0x36,6],[0x2e,6],[0x3e,7],                             // ROL
       [0x6a,2],[0x66,5],[0x76,6],[0x6e,6],[0x7e,7],                             // ROR
       [0x4c,3],[0x6c,5],[0x20,6],[0x60,6],[0x40,6],
       [0x10,2],[0x30,2],[0x50,2],[0x70,2],[0x90,2],[0xb0,2],[0xd0,2],[0xf0,2],
       [0x18,2],[0x38,2],[0x58,2],[0x78,2],[0xb8,2],[0xd8,2],[0xf8,2],[0xea,2],
       [0x00,7]]);
}
// reads that pay +1 on a page cross
const PX = new Uint8Array(256);
for (const op of [0xbd,0xb9,0xb1,0xbe,0xbc,
                  0x7d,0x79,0x71,0xfd,0xf9,0xf1,0x3d,0x39,0x31,
                  0x1d,0x19,0x11,0x5d,0x59,0x51,0xdd,0xd9,0xd1]) PX[op] = 1;

export function step(c) {
  const op = rd(c, c.pc++);
  c.px = 0;
  let a;
  switch (op) {
    // loads/stores
    case 0xa9: c.a = nz(c, rd(c, c.pc++)); break;
    case 0xa5: c.a = nz(c, rd(c, aZP(c))); break;
    case 0xb5: c.a = nz(c, rd(c, aZPX(c))); break;
    case 0xad: c.a = nz(c, rd(c, aABS(c))); break;
    case 0xbd: c.a = nz(c, rd(c, aABSX(c))); break;
    case 0xb9: c.a = nz(c, rd(c, aABSY(c))); break;
    case 0xa1: c.a = nz(c, rd(c, aINDX(c))); break;
    case 0xb1: c.a = nz(c, rd(c, aINDY(c))); break;
    case 0xa2: c.x = nz(c, rd(c, c.pc++)); break;
    case 0xa6: c.x = nz(c, rd(c, aZP(c))); break;
    case 0xb6: c.x = nz(c, rd(c, aZPY(c))); break;
    case 0xae: c.x = nz(c, rd(c, aABS(c))); break;
    case 0xbe: c.x = nz(c, rd(c, aABSY(c))); break;
    case 0xa0: c.y = nz(c, rd(c, c.pc++)); break;
    case 0xa4: c.y = nz(c, rd(c, aZP(c))); break;
    case 0xb4: c.y = nz(c, rd(c, aZPX(c))); break;
    case 0xac: c.y = nz(c, rd(c, aABS(c))); break;
    case 0xbc: c.y = nz(c, rd(c, aABSX(c))); break;
    case 0x85: wr(c, aZP(c), c.a); break;
    case 0x95: wr(c, aZPX(c), c.a); break;
    case 0x8d: wr(c, aABS(c), c.a); break;
    case 0x9d: wr(c, aABSX(c), c.a); break;
    case 0x99: wr(c, aABSY(c), c.a); break;
    case 0x81: wr(c, aINDX(c), c.a); break;
    case 0x91: wr(c, aINDY(c), c.a); break;
    case 0x86: wr(c, aZP(c), c.x); break;
    case 0x96: wr(c, aZPY(c), c.x); break;
    case 0x8e: wr(c, aABS(c), c.x); break;
    case 0x84: wr(c, aZP(c), c.y); break;
    case 0x94: wr(c, aZPX(c), c.y); break;
    case 0x8c: wr(c, aABS(c), c.y); break;
    // transfers
    case 0xaa: c.x = nz(c, c.a); break;
    case 0xa8: c.y = nz(c, c.a); break;
    case 0x8a: c.a = nz(c, c.x); break;
    case 0x98: c.a = nz(c, c.y); break;
    case 0xba: c.x = nz(c, c.sp); break;
    case 0x9a: c.sp = c.x; break;
    // stack
    case 0x48: push(c, c.a); break;
    case 0x68: c.a = nz(c, pop(c)); break;
    case 0x08: push(c, flags(c) | 0x10); break;
    case 0x28: setFlags(c, pop(c)); break;
    // alu
    case 0x69: adc(c, rd(c, c.pc++)); break;
    case 0x65: adc(c, rd(c, aZP(c))); break;
    case 0x75: adc(c, rd(c, aZPX(c))); break;
    case 0x6d: adc(c, rd(c, aABS(c))); break;
    case 0x7d: adc(c, rd(c, aABSX(c))); break;
    case 0x79: adc(c, rd(c, aABSY(c))); break;
    case 0x61: adc(c, rd(c, aINDX(c))); break;
    case 0x71: adc(c, rd(c, aINDY(c))); break;
    case 0xe9: sbc(c, rd(c, c.pc++)); break;
    case 0xe5: sbc(c, rd(c, aZP(c))); break;
    case 0xf5: sbc(c, rd(c, aZPX(c))); break;
    case 0xed: sbc(c, rd(c, aABS(c))); break;
    case 0xfd: sbc(c, rd(c, aABSX(c))); break;
    case 0xf9: sbc(c, rd(c, aABSY(c))); break;
    case 0xe1: sbc(c, rd(c, aINDX(c))); break;
    case 0xf1: sbc(c, rd(c, aINDY(c))); break;
    case 0x29: c.a = nz(c, c.a & rd(c, c.pc++)); break;
    case 0x25: c.a = nz(c, c.a & rd(c, aZP(c))); break;
    case 0x35: c.a = nz(c, c.a & rd(c, aZPX(c))); break;
    case 0x2d: c.a = nz(c, c.a & rd(c, aABS(c))); break;
    case 0x3d: c.a = nz(c, c.a & rd(c, aABSX(c))); break;
    case 0x39: c.a = nz(c, c.a & rd(c, aABSY(c))); break;
    case 0x21: c.a = nz(c, c.a & rd(c, aINDX(c))); break;
    case 0x31: c.a = nz(c, c.a & rd(c, aINDY(c))); break;
    case 0x09: c.a = nz(c, c.a | rd(c, c.pc++)); break;
    case 0x05: c.a = nz(c, c.a | rd(c, aZP(c))); break;
    case 0x15: c.a = nz(c, c.a | rd(c, aZPX(c))); break;
    case 0x0d: c.a = nz(c, c.a | rd(c, aABS(c))); break;
    case 0x1d: c.a = nz(c, c.a | rd(c, aABSX(c))); break;
    case 0x19: c.a = nz(c, c.a | rd(c, aABSY(c))); break;
    case 0x01: c.a = nz(c, c.a | rd(c, aINDX(c))); break;
    case 0x11: c.a = nz(c, c.a | rd(c, aINDY(c))); break;
    case 0x49: c.a = nz(c, c.a ^ rd(c, c.pc++)); break;
    case 0x45: c.a = nz(c, c.a ^ rd(c, aZP(c))); break;
    case 0x55: c.a = nz(c, c.a ^ rd(c, aZPX(c))); break;
    case 0x4d: c.a = nz(c, c.a ^ rd(c, aABS(c))); break;
    case 0x5d: c.a = nz(c, c.a ^ rd(c, aABSX(c))); break;
    case 0x59: c.a = nz(c, c.a ^ rd(c, aABSY(c))); break;
    case 0x41: c.a = nz(c, c.a ^ rd(c, aINDX(c))); break;
    case 0x51: c.a = nz(c, c.a ^ rd(c, aINDY(c))); break;
    case 0xc9: cmp(c, c.a, rd(c, c.pc++)); break;
    case 0xc5: cmp(c, c.a, rd(c, aZP(c))); break;
    case 0xd5: cmp(c, c.a, rd(c, aZPX(c))); break;
    case 0xcd: cmp(c, c.a, rd(c, aABS(c))); break;
    case 0xdd: cmp(c, c.a, rd(c, aABSX(c))); break;
    case 0xd9: cmp(c, c.a, rd(c, aABSY(c))); break;
    case 0xc1: cmp(c, c.a, rd(c, aINDX(c))); break;
    case 0xd1: cmp(c, c.a, rd(c, aINDY(c))); break;
    case 0xe0: cmp(c, c.x, rd(c, c.pc++)); break;
    case 0xe4: cmp(c, c.x, rd(c, aZP(c))); break;
    case 0xec: cmp(c, c.x, rd(c, aABS(c))); break;
    case 0xc0: cmp(c, c.y, rd(c, c.pc++)); break;
    case 0xc4: cmp(c, c.y, rd(c, aZP(c))); break;
    case 0xcc: cmp(c, c.y, rd(c, aABS(c))); break;
    case 0x24: { const m = rd(c, aZP(c)); c.z = (c.a & m) ? 0 : 1; c.n = m >> 7; c.v = (m >> 6) & 1; break; }
    case 0x2c: { const m = rd(c, aABS(c)); c.z = (c.a & m) ? 0 : 1; c.n = m >> 7; c.v = (m >> 6) & 1; break; }
    // inc/dec
    case 0xe6: a = aZP(c); wr(c, a, nz(c, rd(c, a) + 1)); break;
    case 0xf6: a = aZPX(c); wr(c, a, nz(c, rd(c, a) + 1)); break;
    case 0xee: a = aABS(c); wr(c, a, nz(c, rd(c, a) + 1)); break;
    case 0xfe: a = aABSX(c); wr(c, a, nz(c, rd(c, a) + 1)); break;
    case 0xc6: a = aZP(c); wr(c, a, nz(c, rd(c, a) - 1)); break;
    case 0xd6: a = aZPX(c); wr(c, a, nz(c, rd(c, a) - 1)); break;
    case 0xce: a = aABS(c); wr(c, a, nz(c, rd(c, a) - 1)); break;
    case 0xde: a = aABSX(c); wr(c, a, nz(c, rd(c, a) - 1)); break;
    case 0xe8: c.x = nz(c, c.x + 1); break;
    case 0xc8: c.y = nz(c, c.y + 1); break;
    case 0xca: c.x = nz(c, c.x - 1); break;
    case 0x88: c.y = nz(c, c.y - 1); break;
    // shifts
    case 0x0a: c.cf = c.a >> 7; c.a = nz(c, c.a << 1); break;
    case 0x06: a = aZP(c); { const m = rd(c, a); c.cf = m >> 7; wr(c, a, nz(c, m << 1)); } break;
    case 0x16: a = aZPX(c); { const m = rd(c, a); c.cf = m >> 7; wr(c, a, nz(c, m << 1)); } break;
    case 0x0e: a = aABS(c); { const m = rd(c, a); c.cf = m >> 7; wr(c, a, nz(c, m << 1)); } break;
    case 0x1e: a = aABSX(c); { const m = rd(c, a); c.cf = m >> 7; wr(c, a, nz(c, m << 1)); } break;
    case 0x4a: c.cf = c.a & 1; c.a = nz(c, c.a >> 1); break;
    case 0x46: a = aZP(c); { const m = rd(c, a); c.cf = m & 1; wr(c, a, nz(c, m >> 1)); } break;
    case 0x56: a = aZPX(c); { const m = rd(c, a); c.cf = m & 1; wr(c, a, nz(c, m >> 1)); } break;
    case 0x4e: a = aABS(c); { const m = rd(c, a); c.cf = m & 1; wr(c, a, nz(c, m >> 1)); } break;
    case 0x5e: a = aABSX(c); { const m = rd(c, a); c.cf = m & 1; wr(c, a, nz(c, m >> 1)); } break;
    case 0x2a: { const t = c.cf; c.cf = c.a >> 7; c.a = nz(c, (c.a << 1) | t); } break;
    case 0x26: a = aZP(c); { const m = rd(c, a); const t = c.cf; c.cf = m >> 7; wr(c, a, nz(c, (m << 1) | t)); } break;
    case 0x36: a = aZPX(c); { const m = rd(c, a); const t = c.cf; c.cf = m >> 7; wr(c, a, nz(c, (m << 1) | t)); } break;
    case 0x2e: a = aABS(c); { const m = rd(c, a); const t = c.cf; c.cf = m >> 7; wr(c, a, nz(c, (m << 1) | t)); } break;
    case 0x3e: a = aABSX(c); { const m = rd(c, a); const t = c.cf; c.cf = m >> 7; wr(c, a, nz(c, (m << 1) | t)); } break;
    case 0x6a: { const t = c.cf; c.cf = c.a & 1; c.a = nz(c, (c.a >> 1) | (t << 7)); } break;
    case 0x66: a = aZP(c); { const m = rd(c, a); const t = c.cf; c.cf = m & 1; wr(c, a, nz(c, (m >> 1) | (t << 7))); } break;
    case 0x76: a = aZPX(c); { const m = rd(c, a); const t = c.cf; c.cf = m & 1; wr(c, a, nz(c, (m >> 1) | (t << 7))); } break;
    case 0x6e: a = aABS(c); { const m = rd(c, a); const t = c.cf; c.cf = m & 1; wr(c, a, nz(c, (m >> 1) | (t << 7))); } break;
    case 0x7e: a = aABSX(c); { const m = rd(c, a); const t = c.cf; c.cf = m & 1; wr(c, a, nz(c, (m >> 1) | (t << 7))); } break;
    // flow
    case 0x4c: c.pc = aABS(c); break;
    case 0x6c: { const p = aABS(c); c.pc = rd(c, p) | (rd(c, (p & 0xff00) | ((p + 1) & 0xff)) << 8); } break;
    case 0x20: { const t = aABS(c); push(c, (c.pc - 1) >> 8); push(c, (c.pc - 1) & 0xff); c.pc = t; } break;
    case 0x60: c.pc = (pop(c) | (pop(c) << 8)) + 1; break;
    case 0x40: setFlags(c, pop(c)); c.pc = pop(c) | (pop(c) << 8); break;
    case 0x10: branch(c, !c.n); break;
    case 0x30: branch(c, c.n); break;
    case 0x50: branch(c, !c.v); break;
    case 0x70: branch(c, c.v); break;
    case 0x90: branch(c, !c.cf); break;
    case 0xb0: branch(c, c.cf); break;
    case 0xd0: branch(c, !c.z); break;
    case 0xf0: branch(c, c.z); break;
    // flags/misc
    case 0x18: c.cf = 0; break;
    case 0x38: c.cf = 1; break;
    case 0x58: c.i = 0; break;
    case 0x78: c.i = 1; break;
    case 0xb8: c.v = 0; break;
    case 0xd8: c.d = 0; break;
    case 0xf8: c.d = 1; break;
    case 0xea: break;
    case 0x00: throw new Error(`BRK at $${(c.pc - 1).toString(16)}`);
    default: throw new Error(`unimplemented opcode $${op.toString(16)} at $${(c.pc - 1).toString(16)}`);
  }
  c.cycles += CYC[op] + (PX[op] ? c.px : 0);
  c.instructions++;
}

// Load a PRG, find the BASIC stub's SYS target, run.
export function run(prg, { maxSteps = 2e9, trapAddr = null, onTrap = null } = {}) {
  const mem = new Uint8Array(0x10000);
  const load = prg[0] | (prg[1] << 8);
  mem.set(prg.subarray(2), load);
  // SYS target from the stub: "1f 08 ea 07 9e 20 <digits>"
  const text = [...prg.subarray(2, 32)].map((b) => String.fromCharCode(b)).join('');
  const m = text.match(/\x9e ?(\d+)/);
  if (!m) throw new Error('no SYS in BASIC stub');
  const c = makeCpu(mem);
  c.pc = Number(m[1]);
  // sentinel return address: RTS from the entry ends the run
  push(c, 0xff); push(c, 0xfe);   // returns to $ffff
  let lastWrites = 0, lastWriteStep = 0;
  for (let i = 0; i < maxSteps; i++) {
    if (c.pc === 0xffff) return { c, mem, done: true, steps: i, cycles: c.cycles };
    if (trapAddr !== null && c.pc === trapAddr && onTrap) onTrap(c);
    const before = c.pc;
    step(c);
    if (c.pc === before) return { c, mem, done: true, selfJmp: true, steps: i, cycles: c.cycles };
    if (c.writes !== lastWrites) { lastWrites = c.writes; lastWriteStep = i; }
    else if (i - lastWriteStep > 100000) return { c, mem, done: true, idle: true, steps: lastWriteStep, cycles: c.cycles };
  }
  return { c, mem, done: false, steps: maxSteps, cycles: c.cycles };
}
