// v-assembler — port of v-assembler.fth: the 6502 code-template engine
// behind cc64's code generator. It models a virtual 16-bit accumulator
// machine on the 6502: the "accumulator" is A (lo) / X (hi), the hardware
// stack holds intermediate values, $zp (>zp) is a zero-page scratch cell,
// $base (>frame) is the zero-page local-variable frame pointer.
//
// Each method emits exactly the bytes the original template produces
// (templates in the original are byte strings with parameter-marker bytes;
// here parameters are plain arguments and size-conditional w:/;w b:/;b
// sections are ifs on `this.size`). Method names keep the original
// spellings, so this file reads side-by-side with v-assembler.fth:
//   vasm['.lda#'](0x1234)   vasm['.size'](1)   vasm['.jmz-ahead']()
//
// Runtime routines are a jump table behind the module's >runtime address:
//   +$08 jmp(zp)  +$0b switch  +$0e mult  +$11 divmod
//   +$14 shl      +$17 shr     +$1a jmp(laststatic)  +$1d jmp(stack)

export const RT = Object.freeze({
  'jmp(zp)': 0x08, switch: 0x0b, mult: 0x0e, divmod: 0x11,
  shl: 0x14, shr: 0x17, 'jmp(laststatic)': 0x1a, 'jmp(stack)': 0x1d,
});

export class CodeBuffer {
  constructor(origin) {
    this.origin = origin;
    this.bytes = [];
  }
  get pc() { return this.origin + this.bytes.length; }
  b(v) { this.bytes.push(v & 0xff); }
  w(v) { this.b(v); this.b(v >> 8); }
  // w! — patch a word at an absolute address already emitted
  wAt(addr, v) {
    const off = addr - this.origin;
    if (off < 0 || off + 1 >= this.bytes.length) throw new Error(`patch outside code: $${addr.toString(16)}`);
    this.bytes[off] = v & 0xff;
    this.bytes[off + 1] = (v >> 8) & 0xff;
  }
  toBytes() { return Uint8Array.from(this.bytes); }
}

const lo = (v) => v & 0xff;
const hi = (v) => (v >> 8) & 0xff;

export class VAsm {
  // layout: { zp: >zp, frame: >frame, runtimePtr: >runtime } from #pragma cc64
  constructor(layout, code) {
    this.zp = layout.zp;
    this.frame = layout.frame;
    this.runtimePtr = layout.runtimePtr;
    this.code = code ?? new CodeBuffer(0);
    this.size = 2; // operand size: 2 = int, 1 = char (.size)
  }

  b(v) { this.code.b(v); }
  w(v) { this.code.w(v); }
  rtJsr(name) { this.b(0x20); this.w(this.runtimePtr + RT[name]); }

  '.size'(n) { this.size = n; }

  // ---- basics ----
  '.lda#'(p) { this.b(0xa9); this.b(lo(p)); this.b(0xa2); this.b(hi(p)); }        // <&#lda >&#ldx
  '.pha'()  { for (const v of [0x48, 0xa8, 0x8a, 0x48, 0x98]) this.b(v); }        // pha tay txa pha tya
  ".pha'"() { for (const v of [0x48, 0x8a, 0x48]) this.b(v); }                    // pha txa pha
  '.pla'()  { for (const v of [0x68, 0xaa, 0x68]) this.b(v); }                    // pla tax pla
  '.word'(v) { this.w(v); }
  '.byte'(v) { this.b(v); }
  '.jsr'(p) { this.b(0x20); this.w(p); }
  '.jsr(zp)'() { this.rtJsr('jmp(zp)'); }
  '.jsr(laststatic)'() { this.rtJsr('jmp(laststatic)'); }
  '.jsr(stack)'() { this.rtJsr('jmp(stack)'); }
  '.rts'() { this.b(0x60); }
  '.ldy#'(p) { this.b(0xa0); this.b(lo(p)); }
  '.args'(p) { this['.ldy#'](p); }
  '.shla'() { for (const v of [0x0a, 0xa8, 0x8a, 0x2a, 0xaa, 0x98]) this.b(v); }  // asl-a tay txa rol-a tax tya
  '.shra'() { for (const v of [0xa8, 0x8a, 0x4a, 0xaa, 0x98, 0x6a]) this.b(v); }  // tay txa lsr-a tax tya ror-a
  '.and#255'() { this.b(0xa2); this.b(0x00); }                                    // 0#ldx

  '.pop-zp'() { for (const v of [0xa8, 0x68, 0x85, this.zp + 1, 0x68, 0x85, this.zp, 0x98]) this.b(v); }
  '.sta-zp'() { for (const v of [0x85, this.zp, 0x86, this.zp + 1]) this.b(v); }
  '.lda-zp'() { for (const v of [0xa5, this.zp, 0xa6, this.zp + 1]) this.b(v); }
  '.lda-base'() { for (const v of [0xa5, this.frame, 0xa6, this.frame + 1]) this.b(v); }

  '.link#'(p) { // tay clc base lda <&#adc base sta base+1 lda >&#adc base+1 sta tya
    for (const v of [0xa8, 0x18, 0xa5, this.frame, 0x69, lo(p), 0x85, this.frame,
      0xa5, this.frame + 1, 0x69, hi(p), 0x85, this.frame + 1, 0x98]) this.b(v);
  }
  '.switch'() { this.rtJsr('switch'); }

  // ---- arithmetics ----
  '.not'() { for (const v of [0x86, this.zp, 0xa2, 0x00, 0x05, this.zp, 0xd0, 0x01, 0xca, 0x8a]) this.b(v); }
  '.neg'() { for (const v of [0x49, 0xff, 0xa8, 0x8a, 0x49, 0xff, 0xaa, 0xc8, 0xd0, 0x01, 0xe8, 0x98]) this.b(v); }
  '.inv'() { for (const v of [0x49, 0xff, 0xa8, 0x8a, 0x49, 0xff, 0xaa, 0x98]) this.b(v); }

  #binImm(op, pre, p) { // [pre] op#lo tay txa op#hi tax tya
    if (pre !== null) this.b(pre);
    for (const v of [op, lo(p), 0xa8, 0x8a, op, hi(p), 0xaa, 0x98]) this.b(v);
  }
  '.add#'(p) { this.#binImm(0x69, 0x18, p); }               // clc adc#
  '.sub#'(p) { this.#binImm(0xe9, 0x38, p); }               // sec sbc#
  '.#sub'(p) { // sec eor#ff adc#lo tay txa eor#ff adc#hi tax tya   (p - acc)
    for (const v of [0x38, 0x49, 0xff, 0x69, lo(p), 0xa8, 0x8a, 0x49, 0xff, 0x69, hi(p), 0xaa, 0x98]) this.b(v);
  }
  '.and#'(p) { this.#binImm(0x29, null, p); }
  '.or#'(p) { this.#binImm(0x09, null, p); }
  '.xor#'(p) { this.#binImm(0x49, null, p); }

  #binZp(op, pre) { // [pre] op-zp tay txa op-zp+1 tax tya
    if (pre !== null) this.b(pre);
    for (const v of [op, this.zp, 0xa8, 0x8a, op, this.zp + 1, 0xaa, 0x98]) this.b(v);
  }
  '.add-zp'() { this.#binZp(0x65, 0x18); }
  '.sub-zp'() { this.#binZp(0xe5, 0x38); }
  '.and-zp'() { this.#binZp(0x25, null); }
  '.or-zp'() { this.#binZp(0x05, null); }
  '.xor-zp'() { this.#binZp(0x45, null); }

  '.add'() { this['.sta-zp'](); this['.pla'](); this['.add-zp'](); }
  '.sub'() { this['.sta-zp'](); this['.pla'](); this['.sub-zp'](); }
  '.and'() { this['.sta-zp'](); this['.pla'](); this['.and-zp'](); }
  '.or'()  { this['.sta-zp'](); this['.pla'](); this['.or-zp'](); }
  '.xor'() { this['.sta-zp'](); this['.pla'](); this['.xor-zp'](); }

  '.ldzp#'(p) { // tay lda#lo sta-zp lda#hi sta-zp+1 tya
    for (const v of [0xa8, 0xa9, lo(p), 0x85, this.zp, 0xa9, hi(p), 0x85, this.zp + 1, 0x98]) this.b(v);
  }
  '(.mult'() { this.rtJsr('mult'); }
  '(.divmod'() { this.rtJsr('divmod'); }
  '.mult#'(p) { this['.sta-zp'](); this['.lda#'](p); this['(.mult'](); }
  '.mult'() { this['.sta-zp'](); this['.pla'](); this['(.mult'](); }
  '.div#'(p) { this['.ldzp#'](p); this['(.divmod'](); }
  '.#div'(p) { this['.sta-zp'](); this['.lda#'](p); this['(.divmod'](); }
  '.div'() { this['.sta-zp'](); this['.pla'](); this['(.divmod'](); }
  '.mod#'(p) { this['.div#'](p); this['.lda-zp'](); }
  '.#mod'(p) { this['.#div'](p); this['.lda-zp'](); }
  '.mod'() { this['.div'](); this['.lda-zp'](); }

  '.tay'() { this.b(0xa8); }
  '(.shl'() { this.rtJsr('shl'); }
  '(.shr'() { this.rtJsr('shr'); }
  '.shl'() { this['.tay'](); this['.pla'](); this['(.shl'](); }
  '.shl#'(p) { this['.ldy#'](p); this['(.shl'](); }
  '.#shl'(p) { this['.tay'](); this['.lda#'](p); this['(.shl'](); }
  '.shr'() { this['.tay'](); this['.pla'](); this['(.shr'](); }
  '.shr#'(p) { this['.ldy#'](p); this['(.shr'](); }
  '.#shr'(p) { this['.tay'](); this['.lda#'](p); this['(.shr'](); }

  '.cmp#'(p) { // 0#ldy >&#cpx sec 0<?[clc]? 0=?[<&#cmp]?
    for (const v of [0xa0, 0x00, 0xe0, hi(p), 0x38, 0x10, 0x01, 0x18, 0xd0, 0x02, 0xc9, lo(p)]) this.b(v);
  }
  '.cmp-zp'() { // 0#ldy zp+1 cpx sec 0<?[clc]? 0=?[zp cmp]?
    for (const v of [0xa0, 0x00, 0xe4, this.zp + 1, 0x38, 0x10, 0x01, 0x18, 0xd0, 0x02, 0xc5, this.zp]) this.b(v);
  }
  '.cmp'() { this['.sta-zp'](); this['.pla'](); this['.cmp-zp'](); }

  '(.eq'() { for (const v of [0xd0, 0x01, 0x88, 0x98, 0xaa]) this.b(v); }  // 0=?[dey]? tya tax
  '(.ne'() { for (const v of [0xf0, 0x01, 0x88, 0x98, 0xaa]) this.b(v); }
  '(.ge'() { for (const v of [0x90, 0x01, 0x88, 0x98, 0xaa]) this.b(v); }  // cs?[dey]?
  '(.lt'() { for (const v of [0xb0, 0x01, 0x88, 0x98, 0xaa]) this.b(v); }
  '(.gt'() { for (const v of [0x90, 0x03, 0xf0, 0x01, 0x88, 0x98, 0xaa]) this.b(v); } // cs?[0<>?[dey]?]?
  '(.le'() { for (const v of [0x90, 0x02, 0xd0, 0x01, 0x88, 0x98, 0xaa]) this.b(v); } // bcc-over 0=?[dey]?

  '.eq'() { this['.cmp'](); this['(.eq'](); }
  '.ne'() { this['.cmp'](); this['(.ne'](); }
  '.eq#'(p) { this['.cmp#'](p); this['(.eq'](); }
  '.ne#'(p) { this['.cmp#'](p); this['(.ne'](); }
  '.ge'() { this['.cmp'](); this['(.ge'](); }
  '.lt'() { this['.cmp'](); this['(.lt'](); }
  '.ge#'(p) { this['.cmp#'](p); this['(.ge'](); }
  '.lt#'(p) { this['.cmp#'](p); this['(.lt'](); }
  '.gt'() { this['.cmp'](); this['(.gt'](); }
  '.le'() { this['.cmp'](); this['(.le'](); }
  '.gt#'(p) { this['.cmp#'](p); this['(.gt'](); }
  '.le#'(p) { this['.cmp#'](p); this['(.le'](); }

  // ---- 'sized' (size-dependent) ----
  '.lda#.s'(p) {
    this.b(0xa9); this.b(lo(p));
    if (this.size === 2) { this.b(0xa2); this.b(hi(p)); }
  }
  '.lda.s'(p) {
    this.b(0xad); this.w(p);
    if (this.size === 2) { this.b(0xae); this.w(p + 1); }
    if (this.size === 1) { this.b(0xa2); this.b(0x00); }
  }
  '.sta.s'(p) {
    this.b(0x8d); this.w(p);
    if (this.size === 2) { this.b(0x8e); this.w(p + 1); }
  }
  '.lda.s(zp)'() {
    if (this.size === 2) { for (const v of [0xa0, 0x01, 0xb1, this.zp, 0xaa, 0x88]) this.b(v); }
    if (this.size === 1) { for (const v of [0xa2, 0x00, 0xa0, 0x00]) this.b(v); }
    this.b(0xb1); this.b(this.zp);
  }
  '.sta.s(zp)'() {
    for (const v of [0xa0, 0x00, 0x91, this.zp]) this.b(v);
    if (this.size === 2) { for (const v of [0x48, 0x8a, 0xc8, 0x91, this.zp, 0x68]) this.b(v); }
  }
  '.lda(base),&'(p) {
    this.b(0xa0); this.b(lo(p)); this.b(0xb1); this.b(this.frame);
    if (this.size === 2) { for (const v of [0xaa, 0x88, 0xb1, this.frame]) this.b(v); }
    if (this.size === 1) { this.b(0xa2); this.b(0x00); }
  }
  '.lda.s(base),#'(n) {
    if (n > 254) {
      this['.lda-base'](); this['.add#'](n); this['.sta-zp'](); this['.lda.s(zp)']();
    } else {
      this['.lda(base),&'](this.size !== 1 ? n + 1 : n);
    }
  }
  '.sta(base),&'(p) {
    this.b(0xa0); this.b(lo(p)); this.b(0x91); this.b(this.frame);
    if (this.size === 2) { for (const v of [0x48, 0x8a, 0xc8, 0x91, this.frame, 0x68]) this.b(v); }
  }
  '.sta.s(base),#'(n) {
    if (n > 254) {
      this[".pha'"](); this['.lda-base'](); this['.add#'](n);
      this['.sta-zp'](); this['.pla'](); this['.sta.s(zp)']();
    } else {
      this['.sta(base),&'](n);
    }
  }

  '.incr.s'(p) {
    this.b(0xee); this.w(p);
    if (this.size === 2) { this.b(0xd0); this.b(0x03); this.b(0xee); this.w(p + 1); }
  }
  '.decr.s'(p) {
    if (this.size === 2) { this.b(0xac); this.w(p); this.b(0xd0); this.b(0x03); this.b(0xce); this.w(p + 1); }
    this.b(0xce); this.w(p);
  }
  '.2incr.s'(p) {
    if (this.size === 2) {
      this.b(0xac); this.w(p); this.b(0xc0); this.b(0xfe); this.b(0x90); this.b(0x03); this.b(0xee); this.w(p + 1);
    }
    this.b(0xee); this.w(p); this.b(0xee); this.w(p);
  }
  '.2decr.s'(p) {
    if (this.size === 2) {
      this.b(0xac); this.w(p); this.b(0xc0); this.b(0x02); this.b(0xb0); this.b(0x03); this.b(0xce); this.w(p + 1);
    }
    this.b(0xce); this.w(p); this.b(0xce); this.w(p);
  }

  // ---- jumps ----
  '.jmp'(p) { this.b(0x4c); this.w(p); }
  '.label'() { return this.code.pc; }
  '.jmp-ahead'() { const at = this.code.pc; this['.jmp'](0); return at; }
  '.resolve-jmp'(at) { this.code.wAt(at + 1, this.code.pc); }
  '.skip0<>'() { for (const v of [0x86, this.zp, 0x05, this.zp, 0xd0, 0x03]) this.b(v); }
  '.skip0='() { for (const v of [0x86, this.zp, 0x05, this.zp, 0xf0, 0x03]) this.b(v); }
  '.jmz'(p) { this['.skip0<>'](); this['.jmp'](p); }
  '.jmn'(p) { this['.skip0='](); this['.jmp'](p); }
  '.jmz-ahead'() { this['.skip0<>'](); return this['.jmp-ahead'](); }
  '.jmn-ahead'() { this['.skip0='](); return this['.jmp-ahead'](); }
}
