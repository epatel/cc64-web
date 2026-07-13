// Code generator — port of codegen.fth (plus the statics/dynamics parts of
// codehandler.fth).
//
// An "object" is an expression value at compile time: { v, t } where t is a
// bitmap type descriptor and v is either the known value (%constant), a
// symbol address, a frame offset (%offset), or a don't-care placeholder when
// the value only exists in the runtime accumulator.

export const T_INT = 1;
export const T_LVALUE = 0x100;
export const T_POINTER = 0x200;
export const T_FUNCTION = 0x400;
export const T_OFFSET = 0x800;
export const T_FASTCALL = 0x1000;
export const T_EXTERN = 0x2000;
export const T_PROTO = 0x4000;
export const T_CONST = 0x8000;

export const TYPE_DEFAULT = T_INT;                       // %default
export const TYPE_GLOBAL = T_INT | T_LVALUE | T_EXTERN;  // %global
export const TYPE_LOCAL = T_INT | T_LVALUE | T_OFFSET;   // %local

export const COND_MASK = 0x0701;
export const EXPR_MASK = 0x9f01;
export const DECL_MASK = 0x3f01;

const MASK16 = 0xffff;
const signed = (v) => (v & 0x8000 ? (v & MASK16) - 0x10000 : v & MASK16);

// type helpers (set/clr/is?/isn't? and the char/int accessors)
export const setChar = (t) => t & ~T_INT;
export const setInt = (t) => t | T_INT;
export const isChar = (t) => (t & T_INT) === 0;
export const isInt = (t) => (t & T_INT) !== 0;
export const is = (t, mask) => (t & mask) === mask;
export const isnt = (t, mask) => (t & mask) === 0;

// size? — 1 only for char that is neither pointer nor function
export const sizeOf = (t) => (isnt(t, T_POINTER) && isnt(t, T_FUNCTION) && isChar(t) ? 1 : 2);

const pointerQ = (t) => is(t, T_POINTER) && isnt(t, T_FUNCTION);
const intPointerQ = (t) => pointerQ(t) && isInt(t);
export const arrayQ = (t) => isnt(t, T_LVALUE | T_FUNCTION) && is(t, T_POINTER);
export const functionQ = (t) => is(t, T_FUNCTION) && isnt(t, T_LVALUE);

// static init-value stream (cstat,/stat,/>staticadr/staticadr>)
export class Statics {
  constructor() { this.bytes = []; this.base = 0; }
  setBase(addr) { this.base = addr; }          // >staticadr
  get addr() { return (this.base - this.bytes.length) & MASK16; } // staticadr>
  cstat(b) { this.bytes.push(b & 0xff); }
  // stat, emits hi byte first — the init stream is reversed into memory,
  // which turns it back into little-endian
  stat(w) { this.cstat(w >> 8); this.cstat(w); }
  toBytes() { return Uint8Array.from(this.bytes); }
}

export class Codegen {
  constructor({ vasm, symtab, statics, layout, error }) {
    this.v = vasm;
    this.symtab = symtab;
    this.statics = statics;
    this.layout = layout;      // needs staticsLast for fastcall arg spill
    this.error = error;        // diagnostic sink (non-fatal)
    this.aUsed = false;
    this.valueFn = null;       // deferred 'value
    this.tosOffs = 0;          // dynamics (>tos-offs)
    this.ptrFastcalls = 0;
  }

  // ---- dynamics (locals frame) ----
  dynOffs() { return this.tosOffs; }
  dynReset() { this.tosOffs = 0; }
  dynAllot(n) { const o = this.tosOffs; this.tosOffs = (this.tosOffs + n) & MASK16; return o; }

  // ---- accumulator bookkeeping ----
  requireAccu() { if (this.aUsed) this.v[".pha'"](); this.aUsed = true; }
  releaseAccu() { this.aUsed = false; }

  nonConstant(o) {
    if (is(o.t, T_CONST)) {
      this.requireAccu();
      this.v['.size'](sizeOf(o.t & ~T_CONST));
      this.v['.lda#.s'](o.v);
      return { v: o.v, t: o.t & ~T_CONST };
    }
    return o;
  }

  value(o) {
    if (is(o.t, T_LVALUE)) {
      o = this.valueFn(o);
      let t = o.t & ~T_LVALUE;
      if (isnt(t, T_FUNCTION) && isnt(t, T_POINTER)) t = setInt(t);
      return { v: o.v, t };
    }
    return o;
  }

  needLValue(o) {
    if (is(o.t, T_LVALUE)) return { v: o.v, t: o.t & ~T_LVALUE };
    this.error('lvalue expected');
    return o;
  }

  // ---- atoms ----
  doNumatom(val) { return { v: val & MASK16, t: TYPE_DEFAULT | T_CONST }; }

  doStringatom(adr) {
    this.requireAccu();
    this.v['.lda#'](adr);
    return { v: 0, t: setChar(TYPE_DEFAULT | T_POINTER) };
  }

  doLdaA(o) {                               // do-lda(a)
    this.v['.size'](sizeOf(o.t));
    if (is(o.t, T_CONST)) {
      this.requireAccu();
      this.v['.lda.s'](o.v);
      return { v: o.v, t: o.t & ~T_CONST };
    }
    this.v['.sta-zp']();
    this.v['.lda.s(zp)']();
    return o;
  }

  doLdaBase(o) {                            // do-lda(base),#
    if (!is(o.t, T_OFFSET)) throw new Error('compiler error: do-lda(base),# without %offset');
    this.requireAccu();
    this.v['.size'](sizeOf(o.t));
    this.v['.lda.s(base),#'](o.v);
    return { v: o.v, t: o.t & ~T_OFFSET };
  }

  doIdatom(name) {
    const sym = this.symtab.findlocal(name) ?? this.symtab.findglobal(name);
    if (!sym) {
      this.error(`undefined: ${name}`);
      return this.doNumatom(0);
    }
    let o = { v: sym.value, t: sym.type & EXPR_MASK };
    if (isnt(o.t, T_OFFSET)) {
      this.valueFn = (x) => this.doLdaA(x);
      return { v: o.v, t: o.t | T_CONST };
    }
    if (is(o.t, T_LVALUE)) {
      this.valueFn = (x) => this.doLdaBase(x);
      return o;
    }
    this.requireAccu();
    this.v['.lda-base']();
    this.v['.add#'](o.v);
    return { v: o.v, t: o.t & ~T_OFFSET };
  }

  // ---- calls ----
  prepareFastCall(o) {
    if (!is(o.t, T_CONST)) {
      if (this.ptrFastcalls) this.v[".pha'"]();
      else { this.v['.size'](2); this.v['.sta.s'](this.layout.staticsLast - 2); }
      this.releaseAccu();
      this.ptrFastcalls++;
    }
    return o;
  }

  putFastArgument(o) { this.nonConstant(this.value(o)); }

  doFastCall(o) {
    if (is(o.t, T_CONST)) this.v['.jsr'](o.v);
    else {
      this.ptrFastcalls--;
      if (this.ptrFastcalls) this.v['.jsr(stack)']();
      else this.v['.jsr(laststatic)']();
    }
    return o;
  }

  prepareCall(o) { return { o: this.value(o), nargs: 0 }; }

  putArgument(nargs, o) {
    this.nonConstant(this.value(o));
    this.v['.size'](2);
    this.v['.sta.s(base),#'](this.dynAllot(2));
    this.releaseAccu();
    return nargs - 2;
  }

  doCall(o, nargs) {
    const offs = this.dynAllot(nargs & MASK16);       // rewinds by 2*#args
    const n = ((offs - this.dynOffs()) & MASK16) >> 1;
    if (is(o.t, T_CONST)) this.requireAccu();
    else this.v['.sta-zp']();
    this.v['.link#'](this.dynOffs());
    this.v['.args'](n);
    if (is(o.t, T_CONST)) this.v['.jsr'](o.v);
    else this.v['.jsr(zp)']();
    this.v['.link#'](-this.dynOffs() & MASK16);
    return o;
  }

  // ---- pointer/address ----
  doPointer(o) {
    const wasL = is(o.t, T_LVALUE);
    o = this.value(o);
    if (is(o.t, T_FUNCTION)) {
      if (wasL) return { v: o.v, t: o.t & ~T_LVALUE };
      this.error('no function pointer');
      return { v: o.v, t: TYPE_DEFAULT };
    }
    if (!is(o.t, T_POINTER)) this.error('pointer expected');
    this.valueFn = (x) => this.doLdaA(x);
    return { v: o.v, t: (o.t & ~T_POINTER) | T_LVALUE };
  }

  doAdress(o) {
    o = this.needLValue(o);
    let { v, t } = o;
    if (is(t, T_OFFSET)) {
      this.requireAccu();
      this.v['.lda-base']();
      this.v['.add#'](v);
      t &= ~T_OFFSET;
    }
    if (sizeOf(t) === 1) t = setInt(t);
    return { v, t: (t | T_POINTER) & ~T_FUNCTION };
  }

  // ---- unary ops ----
  #unop(o, hostFn, tmpl) {
    o = this.value(o);
    if (is(o.t, T_CONST)) return { v: hostFn(o.v) & MASK16, t: TYPE_DEFAULT | T_CONST };
    this.v[tmpl]();
    return { v: o.v, t: TYPE_DEFAULT };
  }
  doNeg(o) { return this.#unop(o, (v) => -v, '.neg'); }
  doNot(o) { return this.#unop(o, (v) => (v === 0 ? 0xffff : 0), '.not'); }
  doInv(o) { return this.#unop(o, (v) => ~v, '.inv'); }

  // ---- increment/decrement ----
  // variants[i] for i = 0 (const address), 2 (const address, pointer),
  // 4 (computed lvalue), 6 (frame offset); mirrors incop's vectors.
  #incop(o, variants) {
    o = this.needLValue(o);
    this.v['.size'](sizeOf(o.t));
    let { v, t } = o;
    if (is(t, T_CONST)) {
      t &= ~T_CONST;
      this.requireAccu();
      variants[intPointerQ(t) ? 2 : 0].call(this, v);
    } else if (is(t, T_OFFSET)) {
      t &= ~T_OFFSET;
      this.requireAccu();
      const amount = intPointerQ(t) ? 2 : 1;
      this.v['.lda.s(base),#'](v);
      variants[6].call(this, v, amount);
    } else {
      this.v['.sta-zp']();
      this.v['.lda.s(zp)']();
      const amount = intPointerQ(t) ? 2 : 1;
      variants[4].call(this, v, amount);
    }
    if (is(t, T_FUNCTION)) return { v, t: TYPE_DEFAULT };
    return { v, t };
  }

  doPreinc(o) {
    return this.#incop(o, {
      0: (v) => { this.v['.incr.s'](v); this.v['.lda.s'](v); },
      2: (v) => { this.v['.2incr.s'](v); this.v['.lda.s'](v); },
      4: (v, n) => { this.v['.add#'](n); this.v['.sta.s(zp)'](); },
      6: (v, n) => { this.v['.add#'](n); this.v['.sta.s(base),#'](v); },
    });
  }
  doPredec(o) {
    return this.#incop(o, {
      0: (v) => { this.v['.decr.s'](v); this.v['.lda.s'](v); },
      2: (v) => { this.v['.2decr.s'](v); this.v['.lda.s'](v); },
      4: (v, n) => { this.v['.sub#'](n); this.v['.sta.s(zp)'](); },
      6: (v, n) => { this.v['.sub#'](n); this.v['.sta.s(base),#'](v); },
    });
  }
  doPostinc(o) {
    return this.#incop(o, {
      0: (v) => { this.v['.lda.s'](v); this.v['.incr.s'](v); },
      2: (v) => { this.v['.lda.s'](v); this.v['.2incr.s'](v); },
      4: (v, n) => { this.v['.pha'](); this.v['.add#'](n); this.v['.sta.s(zp)'](); this.v['.pla'](); },
      6: (v, n) => { this.v['.pha'](); this.v['.add#'](n); this.v['.sta.s(base),#'](v); this.v['.pla'](); },
    });
  }
  doPostdec(o) {
    return this.#incop(o, {
      0: (v) => { this.v['.lda.s'](v); this.v['.decr.s'](v); },
      2: (v) => { this.v['.lda.s'](v); this.v['.2decr.s'](v); },
      4: (v, n) => { this.v['.pha'](); this.v['.sub#'](n); this.v['.sta.s(zp)'](); this.v['.pla'](); },
      6: (v, n) => { this.v['.pha'](); this.v['.sub#'](n); this.v['.sta.s(base),#'](v); this.v['.pla'](); },
    });
  }

  // ---- binary ops ----
  // vec = { both: hostFn, rconst: tmplName, lconst: tmplName, none: tmplName }
  // mirrors do-binop's const-vec dispatch; this.typ set by the caller.
  #doBinop(o1, o2, vec) {
    const r = (is(o2.t, T_CONST) ? 2 : 0) | (is(o1.t, T_CONST) ? 4 : 0);
    let v;
    if (r === 6) { this.typ |= T_CONST; v = vec.both(o1.v, o2.v) & MASK16; }
    else if (r === 2) { vec.rconst(o2.v); v = o1.v; }
    else if (r === 4) { vec.lconst(o1.v); v = o2.v; }
    else { vec.none(); v = o1.v; }
    return { v, t: this.typ };
  }

  #binop(o1, o2, vec) {
    this.typ = TYPE_DEFAULT;
    return this.#doBinop(o1, o2, vec);
  }

  doShlaObj(o) {                    // do-shla (pointer scaling)
    if (is(o.t, T_CONST)) return { v: (o.v << 1) & MASK16, t: o.t };
    this.v['.shla']();
    return o;
  }
  doShraObj(o) {                    // do-shra
    if (is(o.t, T_CONST)) return { v: (signed(o.v) >> 1) & MASK16, t: o.t };
    this.v['.shra']();
    return o;
  }

  // pointer scaling in do-add/do-sub tests only the LEFT operand (obj1),
  // exactly like the original — `int + ptr` is not scaled.
  doAdd(o1, o2) {
    if (pointerQ(o1.t)) {
      this.typ = o1.t & ~T_CONST;
      if (isInt(o1.t)) o2 = this.doShlaObj(o2);
    } else {
      this.typ = TYPE_DEFAULT;
    }
    return this.#doBinop(o1, o2, {
      both: (a, b) => a + b,
      rconst: (p) => this.v['.add#'](p),
      lconst: (p) => this.v['.add#'](p),
      none: () => this.v['.add'](),
    });
  }

  doSub(o1, o2) {
    let shra = false;
    this.typ = TYPE_DEFAULT;
    if (pointerQ(o1.t)) {
      if (pointerQ(o2.t)) {
        if (isInt(o1.t) && isInt(o2.t)) shra = true;   // ptr - ptr: scale result down
      } else {
        this.typ = o1.t & ~T_CONST;
        if (isInt(o1.t)) o2 = this.doShlaObj(o2);      // ptr - int: scale the int
      }
    }
    let res = this.#doBinop(o1, o2, {
      both: (a, b) => a - b,
      rconst: (p) => this.v['.sub#'](p),
      lconst: (p) => this.v['.#sub'](p),
      none: () => this.v['.sub'](),
    });
    if (shra) res = this.doShraObj(res);
    return res;
  }

  doMult(o1, o2) {
    return this.#binop(o1, o2, {
      both: (a, b) => a * b,
      rconst: (p) => this.v['.mult#'](p),
      lconst: (p) => this.v['.mult#'](p),
      none: () => this.v['.mult'](),
    });
  }
  doDiv(o1, o2) {
    return this.#binop(o1, o2, {
      both: (a, b) => Math.floor(signed(a) / signed(b)),
      rconst: (p) => this.v['.div#'](p),
      lconst: (p) => this.v['.#div'](p),
      none: () => this.v['.div'](),
    });
  }
  doMod(o1, o2) {
    return this.#binop(o1, o2, {
      both: (a, b) => { const x = signed(a), y = signed(b); return x - Math.floor(x / y) * y; },
      rconst: (p) => this.v['.mod#'](p),
      lconst: (p) => this.v['.#mod'](p),
      none: () => this.v['.mod'](),
    });
  }
  doAnd(o1, o2) {
    return this.#binop(o1, o2, {
      both: (a, b) => a & b,
      rconst: (p) => this.v['.and#'](p),
      lconst: (p) => this.v['.and#'](p),
      none: () => this.v['.and'](),
    });
  }
  doXor(o1, o2) {
    return this.#binop(o1, o2, {
      both: (a, b) => a ^ b,
      rconst: (p) => this.v['.xor#'](p),
      lconst: (p) => this.v['.xor#'](p),
      none: () => this.v['.xor'](),
    });
  }
  doOr(o1, o2) {
    return this.#binop(o1, o2, {
      both: (a, b) => a | b,
      rconst: (p) => this.v['.or#'](p),
      lconst: (p) => this.v['.or#'](p),
      none: () => this.v['.or'](),
    });
  }

  doLt(o1, o2) {
    return this.#binop(o1, o2, {
      both: (a, b) => (signed(a) < signed(b) ? 0xffff : 0),
      rconst: (p) => this.v['.lt#'](p),
      lconst: (p) => this.v['.gt#'](p),
      none: () => this.v['.lt'](),
    });
  }
  doGt(o1, o2) {
    return this.#binop(o1, o2, {
      both: (a, b) => (signed(a) > signed(b) ? 0xffff : 0),
      rconst: (p) => this.v['.gt#'](p),
      lconst: (p) => this.v['.lt#'](p),
      none: () => this.v['.gt'](),
    });
  }
  doLe(o1, o2) {
    return this.#binop(o1, o2, {
      both: (a, b) => (signed(a) <= signed(b) ? 0xffff : 0),
      rconst: (p) => this.v['.le#'](p),
      lconst: (p) => this.v['.ge#'](p),
      none: () => this.v['.le'](),
    });
  }
  doGe(o1, o2) {
    return this.#binop(o1, o2, {
      both: (a, b) => (signed(a) >= signed(b) ? 0xffff : 0),
      rconst: (p) => this.v['.ge#'](p),
      lconst: (p) => this.v['.le#'](p),
      none: () => this.v['.ge'](),
    });
  }
  doEq(o1, o2) {
    return this.#binop(o1, o2, {
      both: (a, b) => ((a & MASK16) === (b & MASK16) ? 0xffff : 0),
      rconst: (p) => this.v['.eq#'](p),
      lconst: (p) => this.v['.eq#'](p),
      none: () => this.v['.eq'](),
    });
  }
  doNe(o1, o2) {
    return this.#binop(o1, o2, {
      both: (a, b) => ((a & MASK16) !== (b & MASK16) ? 0xffff : 0),
      rconst: (p) => this.v['.ne#'](p),
      lconst: (p) => this.v['.ne#'](p),
      none: () => this.v['.ne'](),
    });
  }
  doShl(o1, o2) {
    return this.#binop(o1, o2, {
      both: (a, b) => { let v = a; for (let i = 0; i < (b & MASK16); i++) v = (v << 1) & MASK16; return v; },
      rconst: (p) => this.v['.shl#'](p),
      lconst: (p) => this.v['.#shl'](p),
      none: () => this.v['.shl'](),
    });
  }
  doShr(o1, o2) {
    return this.#binop(o1, o2, {
      both: (a, b) => { let v = signed(a); for (let i = 0; i < (b & MASK16); i++) v >>= 1; return v & MASK16; },
      rconst: (p) => this.v['.shr#'](p),
      lconst: (p) => this.v['.#shr'](p),
      none: () => this.v['.shr'](),
    });
  }

  // ---- logical &&, || ----
  doLAnd1(o) {
    this.nonConstant(this.value(o));
    const adr = this.v['.jmz-ahead']();
    this.releaseAccu();
    return adr;
  }
  doLOr1(o) {
    this.nonConstant(this.value(o));
    const adr = this.v['.jmn-ahead']();
    this.releaseAccu();
    return adr;
  }
  doLAndOr2(adr, o) {
    this.nonConstant(this.value(o));
    this.v['.resolve-jmp'](adr);
    return { v: 0, t: TYPE_DEFAULT };
  }

  // ---- ?: ----
  doCond1(o) {
    this.nonConstant(this.value(o));
    this.releaseAccu();
    return this.v['.jmz-ahead']();
  }
  doCond2(adr1, o2) {
    o2 = this.value(o2);
    const zero2 = is(o2.t, T_CONST) && o2.v === 0;
    o2 = this.nonConstant(o2);
    const adr2 = this.v['.jmp-ahead']();
    this.v['.resolve-jmp'](adr1);
    this.releaseAccu();
    return { o2, zero2, adr2 };
  }
  doCond3(state, o3) {
    o3 = this.value(o3);
    const zero3 = is(o3.t, T_CONST) && o3.v === 0;
    o3 = this.nonConstant(o3);
    this.v['.resolve-jmp'](state.adr2);
    const { o2, zero2 } = state;
    if (((o2.t ^ o3.t) & COND_MASK) === 0) return o3;
    if (zero3) return o2;
    if (zero2) return o3;
    this.error('type mismatch in ?:');
    return { v: 0, t: TYPE_DEFAULT };
  }

  // ---- assignment ----
  prepareAsgnop(o) {
    const target = this.needLValue(o);
    // computed lvalue: its address sits in the accu — save it across the load
    if ((target.t & (T_CONST | T_OFFSET)) === 0) this.v['.pha']();
    const loaded = this.value({ v: target.v, t: target.t | T_LVALUE });
    return { target, loaded };
  }

  prepareAssign(o) { return this.needLValue(o); }

  doAssign(target, o2) {
    this.nonConstant(o2);            // 'obj2' is always a value already
    const size = sizeOf(target.t);
    this.v['.size'](size);
    if (size === 1) this.v['.and#255']();
    if (is(target.t, T_CONST)) {
      this.v['.sta.s'](target.v);
      return { v: target.v, t: target.t & ~T_CONST };
    }
    if (is(target.t, T_OFFSET)) {
      this.v['.sta.s(base),#'](target.v);
      return { v: target.v, t: target.t & ~T_OFFSET };
    }
    this.v['.pop-zp']();
    this.v['.sta.s(zp)']();
    return target;
  }
}
