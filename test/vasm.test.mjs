// v-assembler tests: exact byte pins for every template (derived from
// v-assembler.fth + the VolksForth 6502 assembler), plus cross-checks that
// template signatures appear verbatim in real cc64 output (golden PRGs).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { VAsm, CodeBuffer } from '../src/vasm.js';
import { parsePragma } from '../src/pragma.js';
import { dissectExecutable } from '../src/linker.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pragma = parsePragma(readFileSync(join(root, 'assets/rt/rt-c64-08-9f.h'), 'latin1'));
// rt-c64: >zp=$fb (+1=$fc), >frame=$fd (+1=$fe), >runtime=$840
const layout = { zp: pragma.zp, frame: pragma.frame, runtimePtr: pragma.runtimePtr };

const emit = (fn, size = 2) => {
  const v = new VAsm(layout, new CodeBuffer(0x1000));
  v['.size'](size);
  fn(v);
  return [...v.code.toBytes()].map((b) => b.toString(16).padStart(2, '0')).join(' ');
};

// [description, emitter, size, expected bytes]
const P = 0x1234; // parameter used in pins: lo=34 hi=12
const pins = [
  ['.lda#', (v) => v['.lda#'](P), 2, 'a9 34 a2 12'],
  ['.pha', (v) => v['.pha'](), 2, '48 a8 8a 48 98'],
  [".pha'", (v) => v[".pha'"](), 2, '48 8a 48'],
  ['.pla', (v) => v['.pla'](), 2, '68 aa 68'],
  ['.jsr', (v) => v['.jsr'](0xffd2), 2, '20 d2 ff'],
  ['.jsr(zp)', (v) => v['.jsr(zp)'](), 2, '20 48 08'],
  ['.jsr(laststatic)', (v) => v['.jsr(laststatic)'](), 2, '20 5a 08'],
  ['.jsr(stack)', (v) => v['.jsr(stack)'](), 2, '20 5d 08'],
  ['.rts', (v) => v['.rts'](), 2, '60'],
  ['.ldy#', (v) => v['.ldy#'](5), 2, 'a0 05'],
  ['.shla', (v) => v['.shla'](), 2, '0a a8 8a 2a aa 98'],
  ['.shra', (v) => v['.shra'](), 2, 'a8 8a 4a aa 98 6a'],
  ['.and#255', (v) => v['.and#255'](), 2, 'a2 00'],
  ['.pop-zp', (v) => v['.pop-zp'](), 2, 'a8 68 85 fc 68 85 fb 98'],
  ['.sta-zp', (v) => v['.sta-zp'](), 2, '85 fb 86 fc'],
  ['.lda-zp', (v) => v['.lda-zp'](), 2, 'a5 fb a6 fc'],
  ['.lda-base', (v) => v['.lda-base'](), 2, 'a5 fd a6 fe'],
  ['.link#', (v) => v['.link#'](4), 2, 'a8 18 a5 fd 69 04 85 fd a5 fe 69 00 85 fe 98'],
  ['.switch', (v) => v['.switch'](), 2, '20 4b 08'],
  ['.not', (v) => v['.not'](), 2, '86 fb a2 00 05 fb d0 01 ca 8a'],
  ['.neg', (v) => v['.neg'](), 2, '49 ff a8 8a 49 ff aa c8 d0 01 e8 98'],
  ['.inv', (v) => v['.inv'](), 2, '49 ff a8 8a 49 ff aa 98'],
  ['.add#', (v) => v['.add#'](P), 2, '18 69 34 a8 8a 69 12 aa 98'],
  ['.sub#', (v) => v['.sub#'](P), 2, '38 e9 34 a8 8a e9 12 aa 98'],
  ['.#sub', (v) => v['.#sub'](P), 2, '38 49 ff 69 34 a8 8a 49 ff 69 12 aa 98'],
  ['.and#', (v) => v['.and#'](P), 2, '29 34 a8 8a 29 12 aa 98'],
  ['.or#', (v) => v['.or#'](P), 2, '09 34 a8 8a 09 12 aa 98'],
  ['.xor#', (v) => v['.xor#'](P), 2, '49 34 a8 8a 49 12 aa 98'],
  ['.add-zp', (v) => v['.add-zp'](), 2, '18 65 fb a8 8a 65 fc aa 98'],
  ['.sub-zp', (v) => v['.sub-zp'](), 2, '38 e5 fb a8 8a e5 fc aa 98'],
  ['.and-zp', (v) => v['.and-zp'](), 2, '25 fb a8 8a 25 fc aa 98'],
  ['.or-zp', (v) => v['.or-zp'](), 2, '05 fb a8 8a 05 fc aa 98'],
  ['.xor-zp', (v) => v['.xor-zp'](), 2, '45 fb a8 8a 45 fc aa 98'],
  ['.add', (v) => v['.add'](), 2, '85 fb 86 fc 68 aa 68 18 65 fb a8 8a 65 fc aa 98'],
  ['.ldzp#', (v) => v['.ldzp#'](P), 2, 'a8 a9 34 85 fb a9 12 85 fc 98'],
  ['(.mult', (v) => v['(.mult'](), 2, '20 4e 08'],
  ['(.divmod', (v) => v['(.divmod'](), 2, '20 51 08'],
  ['.mod#', (v) => v['.mod#'](P), 2, 'a8 a9 34 85 fb a9 12 85 fc 98 20 51 08 a5 fb a6 fc'],
  ['.shl#', (v) => v['.shl#'](3), 2, 'a0 03 20 54 08'],
  ['.shr', (v) => v['.shr'](), 2, 'a8 68 aa 68 20 57 08'],
  ['.cmp#', (v) => v['.cmp#'](P), 2, 'a0 00 e0 12 38 10 01 18 d0 02 c9 34'],
  ['.cmp-zp', (v) => v['.cmp-zp'](), 2, 'a0 00 e4 fc 38 10 01 18 d0 02 c5 fb'],
  ['(.eq', (v) => v['(.eq'](), 2, 'd0 01 88 98 aa'],
  ['(.ne', (v) => v['(.ne'](), 2, 'f0 01 88 98 aa'],
  ['(.ge', (v) => v['(.ge'](), 2, '90 01 88 98 aa'],
  ['(.lt', (v) => v['(.lt'](), 2, 'b0 01 88 98 aa'],
  ['(.gt', (v) => v['(.gt'](), 2, '90 03 f0 01 88 98 aa'],
  ['(.le', (v) => v['(.le'](), 2, '90 02 d0 01 88 98 aa'],
  ['.lda#.s w', (v) => v['.lda#.s'](P), 2, 'a9 34 a2 12'],
  ['.lda#.s b', (v) => v['.lda#.s'](P), 1, 'a9 34'],
  ['.lda.s w', (v) => v['.lda.s'](P), 2, 'ad 34 12 ae 35 12'],
  ['.lda.s b', (v) => v['.lda.s'](P), 1, 'ad 34 12 a2 00'],
  ['.sta.s w', (v) => v['.sta.s'](P), 2, '8d 34 12 8e 35 12'],
  ['.sta.s b', (v) => v['.sta.s'](P), 1, '8d 34 12'],
  ['.lda.s(zp) w', (v) => v['.lda.s(zp)'](), 2, 'a0 01 b1 fb aa 88 b1 fb'],
  ['.lda.s(zp) b', (v) => v['.lda.s(zp)'](), 1, 'a2 00 a0 00 b1 fb'],
  ['.sta.s(zp) w', (v) => v['.sta.s(zp)'](), 2, 'a0 00 91 fb 48 8a c8 91 fb 68'],
  ['.sta.s(zp) b', (v) => v['.sta.s(zp)'](), 1, 'a0 00 91 fb'],
  ['.lda(base),& w', (v) => v['.lda(base),&'](4), 2, 'a0 04 b1 fd aa 88 b1 fd'],
  ['.lda(base),& b', (v) => v['.lda(base),&'](4), 1, 'a0 04 b1 fd a2 00'],
  ['.lda.s(base),# w small', (v) => v['.lda.s(base),#'](4), 2, 'a0 05 b1 fd aa 88 b1 fd'], // note the +1
  ['.lda.s(base),# b small', (v) => v['.lda.s(base),#'](4), 1, 'a0 04 b1 fd a2 00'],
  ['.sta(base),& w', (v) => v['.sta(base),&'](4), 2, 'a0 04 91 fd 48 8a c8 91 fd 68'],
  ['.sta.s(base),# w small', (v) => v['.sta.s(base),#'](4), 2, 'a0 04 91 fd 48 8a c8 91 fd 68'],
  ['.incr.s w', (v) => v['.incr.s'](P), 2, 'ee 34 12 d0 03 ee 35 12'],
  ['.incr.s b', (v) => v['.incr.s'](P), 1, 'ee 34 12'],
  ['.decr.s w', (v) => v['.decr.s'](P), 2, 'ac 34 12 d0 03 ce 35 12 ce 34 12'],
  ['.decr.s b', (v) => v['.decr.s'](P), 1, 'ce 34 12'],
  ['.2incr.s w', (v) => v['.2incr.s'](P), 2, 'ac 34 12 c0 fe 90 03 ee 35 12 ee 34 12 ee 34 12'],
  ['.2decr.s w', (v) => v['.2decr.s'](P), 2, 'ac 34 12 c0 02 b0 03 ce 35 12 ce 34 12 ce 34 12'],
  ['.jmp', (v) => v['.jmp'](P), 2, '4c 34 12'],
  ['.skip0<>', (v) => v['.skip0<>'](), 2, '86 fb 05 fb d0 03'],
  ['.skip0=', (v) => v['.skip0='](), 2, '86 fb 05 fb f0 03'],
  ['.jmz', (v) => v['.jmz'](P), 2, '86 fb 05 fb d0 03 4c 34 12'],
  ['.jmn', (v) => v['.jmn'](P), 2, '86 fb 05 fb f0 03 4c 34 12'],
];

for (const [name, fn, size, expected] of pins) {
  assert.strictEqual(emit(fn, size), expected, name);
}
console.log(`ok: ${pins.length} template byte pins`);

// jmp-ahead / resolve-jmp mechanics
{
  const v = new VAsm(layout, new CodeBuffer(0x2000));
  const at = v['.jmz-ahead']();
  v['.rts']();
  v['.resolve-jmp'](at);           // resolves to pc after rts = $2000+10
  const bytes = [...v.code.toBytes()];
  assert.deepStrictEqual(bytes.slice(6), [0x4c, 0x0a, 0x20, 0x60]);
  console.log('ok: jmp-ahead/resolve-jmp');
}

// cross-check: template signatures appear verbatim in real cc64 output
{
  const find = (hay, sig) => {
    outer: for (let i = 0; i + sig.length <= hay.length; i++) {
      for (let j = 0; j < sig.length; j++) if (hay[i + j] !== sig[j]) continue outer;
      return true;
    }
    return false;
  };
  const raw = (fn, size = 2) => {
    const v = new VAsm(layout, new CodeBuffer(0));
    v['.size'](size);
    fn(v);
    return v.code.toBytes();
  };
  const cases = {
    'helloworld-c64.prg': ['.jsr ffd2|.jsr,0xffd2', '.pha|.pha', '.pla|.pla', '.skip0<>|.skip0<>',
      '.skip0=|.skip0=', '.sta-zp|.sta-zp', '(.le|(.le', '(.ne|(.ne'],
    'sieve-c64.prg': ['.cmp-zp|.cmp-zp', '.pop-zp|.pop-zp', '.add-zp|.add-zp', '.neg|.neg',
      '(.divmod|(.divmod'],
  };
  for (const [prgName, sigs] of Object.entries(cases)) {
    const prg = new Uint8Array(readFileSync(join(root, 'test/fixtures/golden', prgName)));
    const { code } = dissectExecutable(prg, pragma);
    for (const s of sigs) {
      const [label, word] = s.split('|');
      const [w, arg] = word.split(',');
      const sig = raw((v) => v[w](arg ? Number(arg) : undefined));
      assert(find(code, sig), `${label} in ${prgName}`);
    }
    console.log(`ok: ${sigs.length} signatures found in ${prgName}`);
  }
}

console.log('vasm tests passed');
