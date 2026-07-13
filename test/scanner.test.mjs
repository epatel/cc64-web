import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { tokenize, T, OP } from '../src/scanner.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const src = (f) => readFileSync(join(fixtures, f), 'utf8');

// helloworld-c64.c spot checks
{
  const toks = tokenize(src('helloworld-c64.c').replace(/^#.*$/gm, '')); // strip preprocessor lines for now
  const kinds = toks.map((t) => t.type);
  assert(kinds.includes(T.KEYWORD) && kinds.includes(T.ID) && kinds.includes(T.STRING), 'basic kinds');
  const str = toks.find((t) => t.type === T.STRING);
  // "hello, world!\n" -> PETSCII: h=0x48 ... \n=13, zero-terminated
  assert.strictEqual(str.value[0], 0x48, 'h -> PETSCII $48');
  assert.strictEqual(str.value[str.value.length - 2], 13, String.raw`\n -> CR`);
  assert.strictEqual(str.value[str.value.length - 1], 0, 'zero-terminated');
  const fastcall = toks.find((t) => t.type === T.KEYWORD && t.kw === '_fastcall');
  assert(fastcall, '_fastcall keyword recognized');
  console.log(`ok: helloworld tokens (${toks.length})`);
}

// operators, numbers, comments
{
  const toks = tokenize('a <<= 0x1F + 017 - 10; /* skip * this */ b != ~c >> 2');
  const ops = toks.filter((t) => t.type === T.OPER).map((t) => t.op);
  assert.deepStrictEqual(ops, ['<<=', '+', '-', '!=', '~', '>>']);
  const nums = toks.filter((t) => t.type === T.NUMBER).map((t) => t.value);
  assert.deepStrictEqual(nums, [0x1f, 0o17, 10, 2]);
  console.log('ok: operators, hex/octal/decimal, comment skipping');
}

// char constants
{
  const toks = tokenize(String.raw`'a' '\n' '\7' '\''`);
  assert.deepStrictEqual(toks.map((t) => t.value), [0x41, 13, 7, 0x27]); // 'a' -> PETSCII $41
  console.log('ok: char constants incl. escapes');
}

// sieve compiles through the scanner without errors
{
  const toks = tokenize(src('sieve-c64.c').replace(/^#.*$/gm, ''));
  assert(toks.length > 100, 'sieve token count');
  console.log(`ok: sieve-c64.c scans clean (${toks.length} tokens)`);
}
console.log('scanner tests passed');
