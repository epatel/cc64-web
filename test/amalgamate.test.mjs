import assert from 'node:assert';
import { amalgamate } from '../src/amalgamate.js';
import { makeFrontend } from '../src/frontend.js';
import { T } from '../src/scanner.js';

// hoisting, dedup, order, comment-awareness
{
  const files = {
    'util.c': '#include "rt-c64-08-9f.h"\n#include "shared.h"\nint twice(n) int n; { return n + n; }\n',
    'main.c': '#include "rt-c64-08-9f.h"\n/* #include "not-this.h" */\nmain() { twice(21); }\n',
    'shared.h': '#define ANSWER 42\n',
    'notes.txt': 'ignored',
  };
  const { source, files: order, includes } = amalgamate(files);
  assert.deepStrictEqual(order, ['main.c', 'util.c'], 'alphabetical .c order');
  assert.deepStrictEqual(includes, ['rt-c64-08-9f.h', 'shared.h'], 'deduped, first-seen order');
  assert(!source.includes('not-this.h,') && !includes.includes('not-this.h'), 'commented include not hoisted');
  assert(source.indexOf('#include "rt-c64-08-9f.h"') < source.indexOf('/* ==== main.c ==== */'), 'includes on top');
  assert.strictEqual(source.match(/#include "rt-c64-08-9f\.h"/g).length, 1, 'no duplicate includes');
  assert(source.includes('/* #include "not-this.h" */'), 'comment body preserved');
  console.log('ok: hoist/dedupe/order/comments');
}

// the unity source flows through the real front end
{
  const rtH = '#pragma cc64 0xfd 0xfb 0x801 0x840 0x9ee 0x9ffe 0xa000 rt-c64-08-9f\n';
  const files = {
    'a.c': '#include "rt-c64-08-9f.h"\n#include "shared.h"\nint f() { return ANSWER; }\n',
    'b.c': '#include "shared.h"\nmain() { f(); }\n',
    'shared.h': '#define ANSWER 42\n',
  };
  const { source } = amalgamate(files);
  const fs = new Map([['rt-c64-08-9f.h', rtH], ['shared.h', files['shared.h']]]);
  const fe = makeFrontend({ source, fileName: 'unity.c', fs });
  while (fe.scanner.thisword().type !== T.EOF) fe.scanner.accept();
  assert.deepStrictEqual(fe.diagnostics, [], 'no diagnostics — incl. no double-defined ANSWER');
  assert.strictEqual(fe.pp.layout.moduleName, 'rt-c64-08-9f', 'pragma reached');
  assert.strictEqual(fe.symtab.findglobal('ANSWER').value, 42);
  console.log('ok: unity source through front end (single ANSWER define)');
}

console.log('amalgamate tests passed');
