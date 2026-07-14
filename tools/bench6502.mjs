// Benchmark a compiled PRG on the cycle-accurate 6502 harness.
// Runs until the program goes idle (no memory writes for 100k instructions),
// RTSes out, or hits a self-jmp — then reports real C64 time.
//
// Usage: node tools/bench6502.mjs file.prg [maxGInstr]
import { readFileSync } from 'node:fs';
import { run } from './run6502.mjs';

const path = process.argv[2];
if (!path) { console.error('usage: node tools/bench6502.mjs file.prg [maxGInstr]'); process.exit(2); }
const maxSteps = (Number(process.argv[3]) || 30) * 1e9;

const PAL_HZ = 985248;
const prg = new Uint8Array(readFileSync(path));
const t0 = performance.now();
const { done, idle, selfJmp, steps, cycles } = run(prg, { maxSteps });
const wall = (performance.now() - t0) / 1000;

const secs = cycles / PAL_HZ;
const how = !done ? `NOT FINISHED (cap ${maxSteps.toLocaleString()} instr)`
  : idle ? 'went idle (no writes)' : selfJmp ? 'self-jmp' : 'returned';
console.log(`${path}: ${how}`);
console.log(`instructions : ${steps.toLocaleString()}`);
console.log(`cycles       : ${cycles.toLocaleString()}  (${(cycles / steps).toFixed(2)} cyc/instr)`);
console.log(`C64 time     : ${secs >= 90 ? (secs / 60).toFixed(1) + ' min' : secs.toFixed(1) + ' s'} (PAL, 1x)`);
console.log(`host wall    : ${wall.toFixed(1)} s (${(steps / wall / 1e6).toFixed(0)} M instr/s)`);
