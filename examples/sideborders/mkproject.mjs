// Joins this directory's .c/.h files into a cc64-web project file
// (boing.cc64proj.json) importable via the ⤒ button in the web UI —
// and compile-checks the result with the actual compiler first.
//
// Usage: node examples/sideborders/mkproject.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const root = join(dir, '../..');
const NAME = 'sideborders';

const files = {};
for (const f of readdirSync(dir).sort()) {
  if (/\.(c|h)$/.test(f)) files[f] = readFileSync(join(dir, f), 'utf8');
}
if (!Object.keys(files).length) throw new Error('no .c/.h files found');

// compile-check exactly like the web UI's "Compile project" (unity build)
const { compile } = await import(join(root, 'src/compile.js'));
const { amalgamate } = await import(join(root, 'src/amalgamate.js'));
const fs = new Map(Object.entries(files));
for (const f of readdirSync(join(root, 'assets/rt'))) {
  const raw = readFileSync(join(root, 'assets/rt', f));
  fs.set(f, /\.(h|c)$/.test(f) ? raw.toString('latin1') : new Uint8Array(raw));
}
const u = amalgamate(files);
const res = compile({ source: u.source, fileName: `${NAME}.c`, fs });
if (!res.prg) {
  console.error('compile check FAILED:\n  ' + res.diagnostics.join('\n  '));
  process.exit(1);
}
writeFileSync(join(dir, `${NAME}.prg`), res.prg);

const out = join(dir, `${NAME}.cc64proj.json`);
writeFileSync(out, JSON.stringify(
  { format: 'cc64web-project', version: 1, name: NAME, files }, null, 2));

console.log(`compile check ok: ${res.prg.length} bytes (${NAME}.prg), ` +
  `code $${res.layout.codeFirst.toString(16)}-$${(res.layout.codeFirst + res.codeBytes).toString(16)}`);
console.log(`project file: ${out} (${Object.keys(files).length} files: ${Object.keys(files).join(', ')})`);
