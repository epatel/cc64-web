// Verifies the D64 writer against VICE's c1541 as an oracle:
// 1. list() matches c1541 -dir
// 2. a SEQ file written by us reads back identically via c1541
// 3. the modified image still passes c1541 validation
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

import { D64, FILETYPE } from '../src/d64.js';
import { buildCompileDisk, extractPrg } from '../src/index.js';
import { textToPetscii, petsciiToText } from '../src/petscii.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const C1541 = process.env.C1541 || '/Applications/vice-arm64-sdl2-3.9/bin/c1541';
const base = readFileSync(join(root, 'assets/cc64-c64files.d64'));

// 1. directory parse matches c1541
const disk = new D64(base);
const ours = disk.list().map((f) => `${f.name}|${f.type.toLowerCase()}|${f.blocks}`);
const c1541dir = execFileSync(C1541, ['-attach', join(root, 'assets/cc64-c64files.d64'), '-dir'])
  .toString()
  .split('\n')
  .map((l) => l.match(/^(\d+)\s+"([^"]+)"\s+(del|seq|prg|usr|rel)/))
  .filter(Boolean)
  .map((m) => `${m[2]}|${m[3]}|${m[1]}`);
assert.deepStrictEqual(ours, c1541dir, 'directory listing mismatch vs c1541');
console.log(`ok: directory matches c1541 (${ours.length} files)`);

// 2. write a source file, read it back through c1541
const source = readFileSync(join(root, 'test/hello2.c'), 'utf8');
const image = buildCompileDisk(base, [{ name: 'hello2.c', text: source }]);
const tmp = mkdtempSync(join(tmpdir(), 'cc64web-'));
const imgPath = join(tmp, 'work.d64');
writeFileSync(imgPath, image);

execFileSync(C1541, ['-attach', imgPath, '-read', 'hello2.c,s', join(tmp, 'hello2.petscii')], { cwd: tmp });
const viaC1541 = readFileSync(join(tmp, 'hello2.petscii'));
assert.deepStrictEqual([...viaC1541], [...textToPetscii(source)], 'SEQ roundtrip mismatch');
console.log('ok: injected SEQ file reads back byte-identical via c1541');

// 3. our own reader agrees
const disk2 = new D64(image);
assert.strictEqual(petsciiToText(disk2.readFile('hello2.c')), source.replace(/[\x00-\x1f]/g, (c) => (c === '\n' ? '\n' : ' ')));
console.log('ok: own readFile roundtrip');

// 4. validate BAM consistency via c1541 (throws on hard corruption)
execFileSync(C1541, ['-attach', imgPath, '-validate']);
const after = new D64(readFileSync(imgPath));
console.log(`ok: c1541 -validate passed, ${after.blocksFree()} blocks free`);
console.log('work image at', imgPath);
