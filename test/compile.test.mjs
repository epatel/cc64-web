// THE differential test: our compiler's output must be byte-identical to
// real cc64's (the golden PRGs produced by the VICE oracle).
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { compile } from '../src/compile.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fs = new Map();
for (const f of readdirSync(join(root, 'assets/rt'))) {
  const raw = readFileSync(join(root, 'assets/rt', f));
  fs.set(f, /\.(h|c)$/.test(f) ? raw.toString('latin1') : new Uint8Array(raw));
}

let failures = 0;
for (const name of ['helloworld-c64', 'sieve-c64', 'printf-c64', 'torture-c64']) {
  const source = readFileSync(join(root, `test/fixtures/${name}.c`), 'utf8');
  const golden = new Uint8Array(readFileSync(join(root, `test/fixtures/golden/${name}.prg`)));
  const res = compile({ source, fileName: `${name}.c`, fs });
  if (res.diagnostics.length) {
    console.log(`FAIL ${name}: diagnostics:`, res.diagnostics);
    failures++;
    continue;
  }
  if (!res.prg) { console.log(`FAIL ${name}: no PRG`); failures++; continue; }
  if (res.prg.length !== golden.length) {
    console.log(`FAIL ${name}: size ${res.prg.length} != golden ${golden.length}`);
    failures++;
    continue;
  }
  let diff = -1;
  for (let i = 0; i < golden.length; i++) if (res.prg[i] !== golden[i]) { diff = i; break; }
  if (diff >= 0) {
    console.log(`FAIL ${name}: first diff at offset ${diff} (addr $${(0x801 - 2 + diff).toString(16)}):`);
    const ctx = (a) => [...a.slice(Math.max(0, diff - 8), diff + 8)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    console.log(`  golden: ${ctx(golden)}`);
    console.log(`  ours:   ${ctx(res.prg)}`);
    failures++;
    continue;
  }
  console.log(`ok: ${name}.c -> ${res.prg.length} bytes, BYTE-IDENTICAL to real cc64`);
}
assert.strictEqual(failures, 0, `${failures} differential failures`);
console.log('compile tests passed');
