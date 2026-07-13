// Preprocessor + symbol table + line-based scanner integration tests.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { makeFrontend } from '../src/frontend.js';
import { parsePragma } from '../src/pragma.js';
import { SymTab } from '../src/symtab.js';
import { T } from '../src/scanner.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rtH = readFileSync(join(root, 'assets/rt/rt-c64-08-9f.h'), 'utf8');
const hello = readFileSync(join(root, 'test/fixtures/helloworld-c64.c'), 'utf8');

const drain = (scanner) => {
  const toks = [];
  while (scanner.thisword().type !== T.EOF) { toks.push(scanner.thisword()); scanner.accept(); }
  return toks;
};

// helloworld through the full front end: include resolved, pragma applied
{
  const fs = new Map([['rt-c64-08-9f.h', rtH]]);
  const fe = makeFrontend({ source: hello, fileName: 'helloworld-c64.c', fs });
  const toks = drain(fe.scanner);
  assert.deepStrictEqual(fe.diagnostics, [], 'no diagnostics');
  const ref = parsePragma(rtH);
  assert.strictEqual(fe.pp.layout.codeFirst, ref.codeLast, 'codeFirst = module code.last');
  assert.strictEqual(fe.pp.layout.staticsLibFirst, ref.staticsFirst);
  assert.strictEqual(fe.pp.layout.staticsLast, ref.staticsLast);
  assert.strictEqual(fe.pp.layout.libCodeName, 'rt-c64-08-9f.o');
  assert.strictEqual(fe.pp.layout.libInitName, 'rt-c64-08-9f.i');
  // the rt header contributes no tokens (only pragma); first token is from user code
  assert.deepStrictEqual([toks[0].kw, toks[1].type], ['extern', T.KEYWORD], 'starts at extern _fastcall');
  console.log(`ok: helloworld front end (${toks.length} tokens, pragma applied)`);
}

// include splicing preserves stream order
{
  const fs = new Map([['mid.h', 'b1 b2']]);
  const fe = makeFrontend({ source: 'a1\n#include "mid.h"\na2', fs });
  assert.deepStrictEqual(drain(fe.scanner).map((t) => t.value), ['a1', 'b1', 'b2', 'a2']);
  console.log('ok: include splicing order');
}

// #define semantics (cpp-define): constant globals, char/int + %extern type
{
  const src = '#define SMALL 10\n#define BIG 0x1234\n#define NEG -5\nx';
  const fe = makeFrontend({ source: src });
  drain(fe.scanner);
  assert.deepStrictEqual(fe.diagnostics, []);
  const g = (n) => fe.symtab.findglobal(n);
  assert.deepStrictEqual([g('SMALL').type, g('SMALL').value], [0x2000, 10], 'char const');
  assert.deepStrictEqual([g('BIG').type, g('BIG').value], [0x2001, 0x1234], 'int const');
  assert.deepStrictEqual([g('NEG').type, g('NEG').value], [0x2001, 0xfffb], 'negative wraps, int');
  console.log('ok: #define constants');
}

// directive errors are diagnosed, line skipped, stream continues
{
  const fe = makeFrontend({ source: '#define int 3\n#define x y\n#bogus\nok' });
  const toks = drain(fe.scanner);
  assert.strictEqual(fe.diagnostics.length, 3, 'three diagnostics');
  assert.deepStrictEqual(toks.map((t) => t.value), ['ok']);
  console.log('ok: directive error recovery');
}

// '#' line inside a /* */ comment is NOT a directive (comment-state check)
{
  const fe = makeFrontend({ source: 'a /*\n#define Z 1\n*/ b' });
  const toks = drain(fe.scanner);
  assert.deepStrictEqual(toks.map((t) => t.value), ['a', 'b']);
  assert.strictEqual(fe.symtab.findglobal('Z'), null, 'Z not defined');
  console.log('ok: directives ignored inside comments');
}

// symbol table scoping rules
{
  const diags = [];
  const st = new SymTab((m) => diags.push(m));
  const g = st.putglobal('n'); g.value = 1;
  const outer = st.putlocal('n'); outer.value = 2;
  st.nestlocal();
  assert.strictEqual(st.findlocal('n').value, 2, 'outer local visible in block');
  const inner = st.putlocal('n'); inner.value = 3;       // shadowing outer: fine
  assert.strictEqual(st.findlocal('n').value, 3, 'inner shadows');
  st.putlocal('n');                                       // same block: double def
  assert.strictEqual(diags.length, 1, 'double def diagnosed');
  st.unnestlocal();
  assert.strictEqual(st.findlocal('n').value, 2, 'inner gone after unnest');
  assert.strictEqual(st.findglobal('n').value, 1, 'global untouched');
  const long = 'a'.repeat(40);
  st.putglobal(long);
  assert(st.findglobal(long.slice(0, 31)), '31-char truncation');
  console.log('ok: symbol table scoping');
}

console.log('frontend tests passed');
