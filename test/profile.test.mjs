// Profiler smoke test: compile-and-profile a small compute program via the
// CLI, check that user functions and the runtime multiply get attributed.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'cc64prof-'));
writeFileSync(join(dir, 'prof.c'), `#include "rt-c64-08-9f.h"
int acc;
int work(n)
int n;
{
  int i;
  i = 0;
  while (n) {
    i = i + n * 3;
    n = n - 1;
  }
  return i;
}
main() { acc = work(200); }
`);

const out = execFileSync('node',
  [join(root, 'tools/profile6502.mjs'), join(dir, 'prof.c')],
  { encoding: 'utf8' });

assert.match(out, /returned/, 'program ran to completion');
assert.match(out, /^work\s+[\d.,]+[MK]?\s+\d+\.\d%.*\s1\s/m, 'work attributed with 1 call');
assert.match(out, /^\$mult\s/m, 'runtime multiply resolved by name');
assert.match(out, /^main\s/m, 'main attributed');
const pcts = [...out.matchAll(/\s(\d+\.\d)%/g)].map((m) => Number(m[1]));
const sum = pcts.reduce((a, b) => a + b, 0);
assert.ok(sum > 99 && sum < 101, `percentages sum to ~100 (got ${sum.toFixed(1)})`);
console.log('profile tests passed');
