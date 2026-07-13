// Linker round-trip against real cc64 output: dissect the oracle-produced
// golden PRGs into their parts using the module pragma, re-link with our
// linker, and require byte-identical results.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { parsePragma } from '../src/pragma.js';
import { linkExecutable, dissectExecutable } from '../src/linker.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rt = (f) => readFileSync(join(root, 'assets/rt', f));
const golden = (f) => new Uint8Array(readFileSync(join(root, 'test/fixtures/golden', f)));

function roundTrip(prgName, moduleBase) {
  const pragma = parsePragma(rt(`${moduleBase}.h`).toString('latin1'));
  assert.strictEqual(pragma.moduleName, moduleBase);
  const prg = golden(prgName);
  const parts = dissectExecutable(prg, pragma);
  assert(parts.mainAddr >= pragma.codeLast && parts.mainAddr < parts.codeLastFinal,
    `main() $${parts.mainAddr.toString(16)} inside generated code`);

  const relinked = linkExecutable({
    pragma,
    moduleO: rt(`${moduleBase}.o`),
    moduleI: rt(`${moduleBase}.i`),
    code: parts.code,
    mainAddr: parts.mainAddr,
    staticsFirst: parts.staticsFirst,
    progInit: parts.progInit,
  });
  assert.strictEqual(relinked.length, prg.length, `${prgName}: length`);
  assert.deepStrictEqual([...relinked], [...prg], `${prgName}: byte-identical`);
  console.log(`ok: ${prgName} (${prg.length} bytes, module ${moduleBase}) round-trips byte-identical`);
  return { pragma, parts };
}

const hello = roundTrip('helloworld-c64.prg', 'rt-c64-08-9f');
assert.strictEqual(hello.parts.libInit.length, 2, 'rt module has 2 init bytes');

const sieve = roundTrip('sieve-c64.prg', 'rt-c64-08-9f');
assert(sieve.parts.progInit.length > 8000, 'sieve statics init dominates the PRG');

const printf = roundTrip('printf-c64.prg', 'libc-c64');
assert.strictEqual(printf.parts.libInit.length, 112, 'libc init block is 112 bytes');

console.log('linker tests passed');
