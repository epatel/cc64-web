// Per-function profiler: compile a cc64 source (or a directory of .c/.h as
// a unity build), run the PRG on the cycle-exact 6502 harness, and attribute
// every instruction/cycle to a function. Runtime helpers ($mult, $divmod,
// $shl, $shr, $switch) are resolved from the runtime module's jump table so
// the usual first bottleneck — the software multiply — shows up by name.
//
// Usage: node tools/profile6502.mjs <file.c | dir> [maxGInstr]
//        make profile SRC=<file.c | dir>
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../src/compile.js';
import { amalgamate } from '../src/amalgamate.js';
import { loadPrg, step } from './run6502.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (!target) { console.error('usage: node tools/profile6502.mjs <file.c | dir> [maxGInstr]'); process.exit(2); }
const maxSteps = (Number(process.argv[3]) || 30) * 1e9;
const PAL_HZ = 985248;

// ---- compile (single file, or unity build of a directory) ----
const fs = new Map();
for (const f of readdirSync(join(root, 'assets/rt'))) {
  const raw = readFileSync(join(root, 'assets/rt', f));
  fs.set(f, /\.(h|c)$/.test(f) ? raw.toString('latin1') : new Uint8Array(raw));
}
let source, fileName;
if (statSync(target).isDirectory()) {
  const files = {};
  for (const f of readdirSync(target).sort()) {
    if (/\.(c|h)$/.test(f)) files[f] = readFileSync(join(target, f), 'utf8');
  }
  for (const [n, t] of Object.entries(files)) fs.set(n, t);
  source = amalgamate(files).source;
  fileName = basename(target) + '.c';
} else {
  for (const f of readdirSync(dirname(target))) {
    if (/\.h$/.test(f)) fs.set(f, readFileSync(join(dirname(target), f), 'utf8'));
  }
  source = readFileSync(target, 'utf8');
  fileName = basename(target);
}
const res = compile({ source, fileName, fs });
if (!res.prg) { console.error(res.diagnostics.join('\n')); process.exit(1); }

// ---- buckets: addr -> function, O(1) per instruction ----
const { layout, functions, codeBytes } = res;
const names = ['(outside: stack/kernal)'];
const map = new Uint16Array(0x10000);          // bucket index per address

const bucket = (name, from, to) => {
  names.push(name);
  map.fill(names.length - 1, from, to);
};

// runtime module: whole lib region first, then carve out the jump-table
// targets ("nearest preceding entry point" attribution within the lib)
const { c, mem } = loadPrg(res.prg);
bucket('(runtime lib)', layout.libFirst, layout.codeFirst);
const rtEntries = [
  [0x0b, '$switch'], [0x0e, '$mult'], [0x11, '$divmod'],
  [0x14, '$shl'], [0x17, '$shr'],
];
const targets = [];
for (const [off, name] of rtEntries) {
  const at = layout.runtimePtr + off;
  if (mem[at] !== 0x4c) continue;              // expect jmp abs
  const t = mem[at + 1] | (mem[at + 2] << 8);
  if (t >= layout.libFirst && t < layout.codeFirst) targets.push([t, name]);
}
targets.sort((a, b) => a[0] - b[0]);
for (let i = 0; i < targets.length; i++) {
  const end = i + 1 < targets.length ? targets[i + 1][0] : layout.codeFirst;
  bucket(targets[i][1], targets[i][0], end);
}

// user functions (in code order; each extends to the next / end of code);
// forward-declared functions leave 3-byte jmp stubs before the first one
const codeEnd = layout.codeFirst + codeBytes;
if (functions.length && functions[0].addr > layout.codeFirst)
  bucket('(proto stubs)', layout.codeFirst, functions[0].addr);
for (let i = 0; i < functions.length; i++) {
  const end = i + 1 < functions.length ? functions[i + 1].addr : codeEnd;
  bucket(functions[i].name, functions[i].addr, end);
}

// ---- run, attributing instructions, cycles and JSR call counts ----
const instr = new Float64Array(names.length);
const cyc = new Float64Array(names.length);
const calls = new Float64Array(names.length);
const t0 = performance.now();
let lastWrites = 0, lastWriteStep = 0, prevCycles = 0;
let i = 0, how = 'returned';
for (; i < maxSteps; i++) {
  const pc = c.pc;
  if (pc === 0xffff) break;
  const b = map[pc];
  if (c.mem[pc] === 0x20) {                    // JSR: count the callee,
    let t = c.mem[pc + 1] | (c.mem[pc + 2] << 8);
    if (c.mem[t] === 0x4c)                     // following one jmp (proto stub)
      t = c.mem[t + 1] | (c.mem[t + 2] << 8);
    calls[map[t]]++;
  }
  step(c);
  instr[b]++;
  cyc[b] += c.cycles - prevCycles;
  prevCycles = c.cycles;
  if (c.pc === pc) { how = 'self-jmp'; break; }
  if (c.writes !== lastWrites) { lastWrites = c.writes; lastWriteStep = i; }
  else if (i - lastWriteStep > 100000) { how = 'went idle'; break; }
}
if (i >= maxSteps) how = `NOT FINISHED (cap ${maxSteps.toLocaleString()})`;
const wall = (performance.now() - t0) / 1000;

// ---- report ----
const totalCyc = c.cycles;
const rows = names
  .map((n, b) => ({ n, i: instr[b], cy: cyc[b], ca: calls[b] }))
  .filter((r) => r.i > 0)
  .sort((a, b) => b.cy - a.cy);
const fmtM = (v) => v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : Math.round(v).toLocaleString();
console.log(`${fileName}: ${res.prg.length} bytes, ${how}; ` +
  `${c.instructions.toLocaleString()} instr, ${totalCyc.toLocaleString()} cycles ` +
  `= ${(totalCyc / PAL_HZ).toFixed(1)} s at 1x PAL  (host ${wall.toFixed(1)} s)`);
console.log('');
console.log('function          cycles      %     instr    calls  cyc/call');
console.log('--------------------------------------------------------------');
for (const r of rows) {
  console.log(
    r.n.padEnd(16) +
    fmtM(r.cy).padStart(8) +
    ((r.cy / totalCyc) * 100).toFixed(1).padStart(7) + '%' +
    fmtM(r.i).padStart(10) +
    (r.ca ? fmtM(r.ca).padStart(9) : '        -') +
    (r.ca ? Math.round(r.cy / r.ca).toLocaleString().padStart(10) : '         -'),
  );
}
