// Parser — port of parser.fth. Recursive descent over the scanner's tokens,
// driving the code generator; single pass, emitting 6502 code as it goes.
//
// Notable mechanics kept from the original:
// - string literals are compiled inline, jumped over (cp$[ ... cp]$)
// - break/continue/case collect jump addresses in stacked lists
// - forward-declared functions (prototypes) emit a 3-byte jmp stub; calls
//   jsr the stub, and the stub's operand is patched by the linker via the
//   protos2patch list ({addr, target}) once the function is defined

import { T } from './scanner.js';
import {
  T_INT, T_LVALUE, T_POINTER, T_FUNCTION, T_OFFSET, T_FASTCALL, T_EXTERN,
  T_PROTO, T_CONST, TYPE_DEFAULT, TYPE_GLOBAL, TYPE_LOCAL, DECL_MASK,
  setChar, setInt, isChar, is, isnt, sizeOf, arrayQ, functionQ,
} from './codegen.js';

export class CompileFatal extends Error {}

const elemSize = (t) =>
  (isChar(t) && (arrayQ(t) || (t & (T_POINTER | T_FUNCTION)) === 0)) ? 1 : 2;

export class Parser {
  constructor({ scanner, symtab, cg, vasm, statics, error }) {
    this.s = scanner;
    this.symtab = symtab;
    this.cg = cg;
    this.v = vasm;
    this.statics = statics;
    this.error = error;

    this.breaks = [];            // stack of lists of jmp addresses
    this.conts = [];
    this.cases = [];             // stack of lists of {value, label}
    this.switchState = 0;        // 0: outside, -1: in switch, addr: default seen
    this.patches = [];           // protos2patch for the linker
    this.protosResolve = new Map(); // sym -> stub jmp operand address

    this.functionDefined = false;
    this.isFirst = true;         // (1st
    this.externFlag = false;
    this.nObj = 1;               // #/obj
    this.dimd = false;           // []dim'd
    this.initd = false;          // []init'd
    this.nInits = 0;             // #inits
    this.initValues = [];
    this.declaratorFn = null;    // 'declarator
    this.putSymbolFn = null;     // 'putsymbol
    this.handleIdFn = () => this.idToBuf();  // handle-id-xt
  }

  // ---- token helpers ----
  tw() { return this.s.thisword(); }
  accept() { this.s.accept(); }

  comesChar(ch) {
    const w = this.tw();
    if (w.type === T.CHAR && w.ch === ch) { this.accept(); return true; }
    return false;
  }
  comesKw(kw) {
    const w = this.tw();
    if (w.type === T.KEYWORD && w.kw === kw) { this.accept(); return true; }
    return false;
  }
  comesOp(op) {
    const w = this.tw();
    if (w.type === T.OPER && w.op === op) { this.accept(); return true; }
    return false;
  }
  peekOp() { const w = this.tw(); return w.type === T.OPER ? w.op : null; }

  expectChar(ch) {
    if (!this.comesChar(ch)) this.error(`'${ch}' expected (line ${this.tw().line})`);
  }

  // ---- expressions ----
  compileString(bytes) {          // cp$[ .byte... cp]$
    const jmp = this.v['.jmp-ahead']();
    const adr = this.v['.label']();
    for (const b of bytes) this.v['.byte'](b);
    this.v['.resolve-jmp'](jmp);
    return adr;
  }

  atom() {
    const w = this.tw();
    if (w.type === T.NUMBER) { this.accept(); return this.cg.doNumatom(w.value); }
    if (w.type === T.ID) { this.accept(); return this.cg.doIdatom(w.value); }
    if (w.type === T.STRING) {
      const adr = this.compileString(w.value);
      const o = this.cg.doStringatom(adr);
      this.accept();
      return o;
    }
    this.error(`a value expected (line ${w.line})`);
    return this.cg.doNumatom(0);
  }

  primaryIndex(o) {               // primary[]
    o = this.cg.value(o);
    let rhs = this.cg.value(this.expression());
    o = this.cg.doAdd(o, rhs);
    o = this.cg.doPointer(o);
    this.expectChar(']');
    return o;
  }

  primaryCall(o) {                // primary()
    if (!functionQ(o.t)) this.error('not a function');
    if (is(o.t, T_FASTCALL)) {
      o = this.cg.prepareFastCall(o);
      if (!this.comesChar(')')) {
        this.cg.putFastArgument(this.assignExpr());
        this.expectChar(')');
      }
      o = this.cg.doFastCall(o);
    } else {
      const pc = this.cg.prepareCall(o);
      o = pc.o;
      let nargs = pc.nargs;
      if (!this.comesChar(')')) {
        do { nargs = this.cg.putArgument(nargs, this.assignExpr()); }
        while (this.comesChar(','));
        this.expectChar(')');
      }
      o = this.cg.doCall(o, nargs);
    }
    return { v: o.v, t: o.t & ~(T_CONST | T_FUNCTION | T_FASTCALL) };
  }

  primary() {
    let o;
    if (this.comesChar('(')) { o = this.expression(); this.expectChar(')'); }
    else o = this.atom();
    for (;;) {
      const m = this.s.mark();
      if (this.comesChar('(')) o = this.primaryCall(o);
      if (this.comesChar('[')) o = this.primaryIndex(o);
      if (!this.s.advanced(m)) return o;
    }
  }

  unary() {
    const UN1 = {
      '-': (o) => this.cg.doNeg(o), '!': (o) => this.cg.doNot(o),
      '~': (o) => this.cg.doInv(o), '*': (o) => this.cg.doPointer(o),
      '&': (o) => this.cg.doAdress(o),
      '++': (o) => this.cg.doPreinc(o), '--': (o) => this.cg.doPredec(o),
    };
    const op = this.peekOp();
    if (op && UN1[op]) { this.accept(); return UN1[op](this.unary()); }
    const o = this.primary();
    if (this.peekOp() === '++') { this.accept(); return this.cg.doPostinc(o); }
    if (this.peekOp() === '--') { this.accept(); return this.cg.doPostdec(o); }
    return o;
  }

  binaryLevel(ops, lower) {
    let o = lower();
    for (;;) {
      const op = this.peekOp();
      const fn = op != null ? ops[op] : undefined;
      if (!fn) return o;
      this.accept();
      o = this.cg.value(o);
      const rhs = this.cg.value(lower());
      o = fn(o, rhs);
    }
  }

  product() {
    return this.binaryLevel({
      '*': (a, b) => this.cg.doMult(a, b), '/': (a, b) => this.cg.doDiv(a, b),
      '%': (a, b) => this.cg.doMod(a, b),
    }, () => this.unary());
  }
  sum() {
    return this.binaryLevel({
      '+': (a, b) => this.cg.doAdd(a, b), '-': (a, b) => this.cg.doSub(a, b),
    }, () => this.product());
  }
  shift() {
    return this.binaryLevel({
      '<<': (a, b) => this.cg.doShl(a, b), '>>': (a, b) => this.cg.doShr(a, b),
    }, () => this.sum());
  }
  comp() {
    return this.binaryLevel({
      '<': (a, b) => this.cg.doLt(a, b), '<=': (a, b) => this.cg.doLe(a, b),
      '>': (a, b) => this.cg.doGt(a, b), '>=': (a, b) => this.cg.doGe(a, b),
    }, () => this.shift());
  }
  equal() {
    return this.binaryLevel({
      '==': (a, b) => this.cg.doEq(a, b), '!=': (a, b) => this.cg.doNe(a, b),
    }, () => this.comp());
  }
  bitAnd() { return this.binaryLevel({ '&': (a, b) => this.cg.doAnd(a, b) }, () => this.equal()); }
  bitXor() { return this.binaryLevel({ '^': (a, b) => this.cg.doXor(a, b) }, () => this.bitAnd()); }
  bitOr() { return this.binaryLevel({ '|': (a, b) => this.cg.doOr(a, b) }, () => this.bitXor()); }

  lAnd() {
    let o = this.bitOr();
    while (this.comesOp('&&')) {
      const adr = this.cg.doLAnd1(o);
      o = this.cg.doLAndOr2(adr, this.bitOr());
    }
    return o;
  }
  lOr() {
    let o = this.lAnd();
    while (this.comesOp('||')) {
      const adr = this.cg.doLOr1(o);
      o = this.cg.doLAndOr2(adr, this.lAnd());
    }
    return o;
  }

  conditional() {
    let o = this.lOr();
    if (this.comesChar('?')) {
      const adr1 = this.cg.doCond1(o);
      const o2 = this.conditional();
      const state = this.cg.doCond2(adr1, o2);
      this.expectChar(':');
      const o3 = this.conditional();
      o = this.cg.doCond3(state, o3);
    }
    return o;
  }

  assignExpr() {
    const ASSIGN_OPS = {
      '=': null,
      '*=': (a, b) => this.cg.doMult(a, b), '/=': (a, b) => this.cg.doDiv(a, b),
      '%=': (a, b) => this.cg.doMod(a, b), '+=': (a, b) => this.cg.doAdd(a, b),
      '-=': (a, b) => this.cg.doSub(a, b), '<<=': (a, b) => this.cg.doShl(a, b),
      '>>=': (a, b) => this.cg.doShr(a, b), '&=': (a, b) => this.cg.doAnd(a, b),
      '^=': (a, b) => this.cg.doXor(a, b), '|=': (a, b) => this.cg.doOr(a, b),
    };
    let o = this.conditional();
    const op = this.peekOp();
    if (op != null && op in ASSIGN_OPS) {
      this.accept();
      const fn = ASSIGN_OPS[op];
      if (fn) {
        const { target, loaded } = this.cg.prepareAsgnop(o);
        const rhs = this.cg.value(this.assignExpr());
        o = this.cg.doAssign(target, fn(loaded, rhs));
      } else {
        const target = this.cg.prepareAssign(o);
        const rhs = this.cg.value(this.assignExpr());
        o = this.cg.doAssign(target, rhs);
      }
    }
    return o;
  }

  expression() {
    let o = this.assignExpr();
    if (this.comesChar(',')) {
      this.cg.nonConstant(this.cg.value(o));
      do {
        this.cg.releaseAccu();
        o = this.cg.nonConstant(this.cg.value(this.assignExpr()));
      } while (this.comesChar(','));
    }
    return o;
  }

  constantExpression() {
    const o = this.cg.value(this.assignExpr());
    if (isnt(o.t, T_CONST)) this.error('constant expected');
    return o.v;
  }

  exprToAccu() {
    this.cg.nonConstant(this.cg.value(this.expression()));
    this.cg.releaseAccu();
  }

  parenExprToAccu() {
    this.expectChar('(');
    this.exprToAccu();
    this.expectChar(')');
  }

  // ---- statements ----
  expressionStmt() { this.exprToAccu(); this.expectChar(';'); }

  returnStmt() {
    if (!this.comesChar(';')) this.expressionStmt();
    this.v['.rts']();
  }

  ifStmt() {
    this.parenExprToAccu();
    const adr = this.v['.jmz-ahead']();
    this.statement();
    if (this.comesKw('else')) {
      const adr2 = this.v['.jmp-ahead']();
      this.v['.resolve-jmp'](adr);
      this.statement();
      this.v['.resolve-jmp'](adr2);
    } else {
      this.v['.resolve-jmp'](adr);
    }
  }

  another(listStack, what) {
    if (listStack.length === 0) { this.error(`illegal ${what}`); return; }
    listStack[listStack.length - 1].push(this.v['.jmp-ahead']());
  }
  resolveList(listStack) {
    for (const adr of listStack.pop()) this.v['.resolve-jmp'](adr);
  }

  breakStmt() { this.another(this.breaks, 'break'); this.expectChar(';'); }
  continueStmt() { this.another(this.conts, 'continue'); this.expectChar(';'); }

  caseStmt() {
    const val = this.constantExpression();
    this.expectChar(':');
    if (this.switchState === 0) { this.error('case outside switch'); return; }
    this.cases[this.cases.length - 1].push({ value: val, label: this.v['.label']() });
  }

  defaultStmt() {
    this.expectChar(':');
    if (this.switchState !== -1) this.error('illegal default');
    else this.switchState = this.v['.label']();
  }

  switchStmt() {
    const outer = this.switchState;
    this.switchState = -1;
    this.breaks.push([]);
    this.cases.push([]);
    this.parenExprToAccu();
    const adrA = this.v['.jmp-ahead']();   // to the dispatch
    this.statement();
    const adrB = this.v['.jmp-ahead']();   // past the dispatch
    this.v['.resolve-jmp'](adrA);
    this.v['.switch']();
    // case table: [label, value] pairs, most recent case first, 0-terminated
    const list = this.cases.pop();
    for (let i = list.length - 1; i >= 0; i--) {
      this.v['.word'](list[i].label);
      this.v['.word'](list[i].value);
    }
    this.v['.word'](0);
    if (this.switchState !== -1) this.v['.jmp'](this.switchState); // default
    this.v['.resolve-jmp'](adrB);
    this.resolveList(this.breaks);
    this.switchState = outer;
  }

  doStmt() {
    this.breaks.push([]); this.conts.push([]);
    const top = this.v['.label']();
    this.statement();
    this.resolveList(this.conts);
    if (!this.comesKw('while')) this.error('while expected');
    this.parenExprToAccu();
    this.v['.jmn'](top);
    this.resolveList(this.breaks);
    this.expectChar(';');
  }

  whileStmt() {
    this.breaks.push([]); this.conts.push([]);
    const top = this.v['.label']();
    this.parenExprToAccu();
    const adr = this.v['.jmz-ahead']();
    this.statement();
    this.resolveList(this.conts);
    this.v['.jmp'](top);
    this.v['.resolve-jmp'](adr);
    this.resolveList(this.breaks);
  }

  forStmt() {
    this.breaks.push([]); this.conts.push([]);
    this.expectChar('(');
    if (!this.comesChar(';')) { this.exprToAccu(); this.expectChar(';'); }  // init
    const condLabel = this.v['.label']();
    let adrTrue, adrFalse = null;
    if (!this.comesChar(';')) {                                             // condition
      this.exprToAccu(); this.expectChar(';');
      adrTrue = this.v['.jmn-ahead']();
      adrFalse = this.v['.jmp-ahead']();
    } else {
      adrTrue = this.v['.jmp-ahead']();
    }
    const incLabel = this.v['.label']();
    if (!this.comesChar(')')) { this.exprToAccu(); this.expectChar(')'); }  // increment
    this.v['.jmp'](condLabel);
    this.v['.resolve-jmp'](adrTrue);                                        // body
    this.statement();
    this.resolveList(this.conts);
    this.v['.jmp'](incLabel);
    if (adrFalse !== null) this.v['.resolve-jmp'](adrFalse);
    this.resolveList(this.breaks);
  }

  statementQ() {
    const STMTS = {
      break: () => this.breakStmt(), continue: () => this.continueStmt(),
      if: () => this.ifStmt(), do: () => this.doStmt(),
      while: () => this.whileStmt(), for: () => this.forStmt(),
      case: () => this.caseStmt(), default: () => this.defaultStmt(),
      switch: () => this.switchStmt(), return: () => this.returnStmt(),
    };
    const w = this.tw();
    if (w.type === T.KEYWORD && STMTS[w.kw]) { this.accept(); STMTS[w.kw](); return true; }
    if (w.type === T.CHAR) {
      if (w.ch === '{') { this.accept(); this.compound(); return true; }
      if (w.ch === ';') { this.accept(); return true; }
      if (w.ch === '}') return false;
    }
    const m = this.s.mark();
    this.expressionStmt();
    return this.s.advanced(m);
  }

  statement() {
    if (!this.statementQ()) this.error(`statement expected (line ${this.tw().line})`);
  }

  // ---- type specifiers ----
  typeNameQ(t) {
    if (this.comesKw('_fastcall')) t |= T_FASTCALL;
    if (this.comesKw('char')) return { t: setChar(t), f: true };
    if (this.comesKw('int')) return { t: setInt(t), f: true };
    return { t, f: false };
  }
  registerQ(t) { return { t, f: this.comesKw('register') }; }
  externQ(t) {
    if (this.comesKw('extern')) {
      this.externFlag = true;
      return { t: (t | T_EXTERN) & ~T_OFFSET, f: true };
    }
    return { t, f: false };
  }
  rangeQ(t) {
    const e = this.externQ(t);
    if (e.f) return e;
    if (this.comesKw('static')) return { t: t & ~T_EXTERN, f: true };
    return { t, f: false };
  }
  classQ(t) {
    let r = this.registerQ(t); if (r.f) return r;
    r = this.externQ(t); if (r.f) return r;
    if (this.comesKw('auto')) return { t, f: true };
    if (this.comesKw('static')) return { t: t & ~T_OFFSET, f: true };
    return { t, f: false };
  }

  orType(classFn, t) {                    // or-type: mechanics
    this.externFlag = false;
    let r = classFn(t);
    if (r.f) return { t: this.typeNameQ(r.t).t, f: true };
    r = this.typeNameQ(t);
    if (r.f) return { t: classFn(r.t).t, f: true };
    return { t, f: false };
  }
  classOrTypeQ(t) { return this.orType((x) => this.classQ(x), t); }
  rangeOrTypeQ(t) { return this.orType((x) => this.rangeQ(x), t); }
  registerOrTypeQ(t) { return this.orType((x) => this.registerQ(x), t); }

  // ---- declarators ----
  expectId() {
    const w = this.tw();
    if (w.type === T.ID) { this.accept(); return w.value; }
    this.error(`identifier expected (line ${w.line})`);
    return null;
  }
  idToBuf() { return this.expectId() ?? ''; }
  idToLocal() {
    const name = this.expectId();
    return name !== null ? this.symtab.putlocal(name) : this.symtab.makePayload('');
  }

  setPointer(t) {
    if (is(t, T_POINTER)) this.error('double pointer');
    return t | T_POINTER;
  }

  handleArray(t) {
    if (!this.comesChar(']')) {
      const isFn = is(t, T_FUNCTION);
      const n = this.constantExpression();
      if (isFn) this.error('array of functions?');
      else { this.nObj = n; this.dimd = true; }
      this.expectChar(']');
    }
    t = this.setPointer(t);
    if (isnt(t, T_FUNCTION)) t &= ~T_LVALUE;
    return t;
  }

  handleFunction(t) {
    if (functionQ(t)) this.symtab.unnestlocal();
    if (is(t, T_FUNCTION)) this.error('function returning function?');
    t |= T_FUNCTION;
    if (is(t, T_POINTER)) {
      if (this.dimd) this.error('bad declarator');
      this.dimd = false;
      this.nObj = 1;
      t = (t & ~T_POINTER) | T_LVALUE;
    } else {
      t &= ~T_LVALUE;
    }
    if (functionQ(t)) {
      this.symtab.nestlocal();
      this.parametersClose();
    } else {
      this.expectChar(')');
    }
    return t;
  }

  paramOk(t) {
    if (arrayQ(t) && !this.dimd) t |= T_LVALUE;
    const isFn = functionQ(t);
    if (isFn) this.symtab.unnestlocal();
    if (arrayQ(t) || isFn) { this.error('bad parameter'); return null; }
    return t;
  }

  idParameters() {
    do {
      const name = this.expectId();
      if (name !== null) {
        const sym = this.symtab.putlocal(name);
        sym.value = this.cg.dynAllot(2);
        sym.type = TYPE_LOCAL;
      }
    } while (this.comesChar(','));
  }

  typedParameters() {
    const saved = this.handleIdFn;
    this.handleIdFn = () => this.idToLocal();
    try {
      for (;;) {
        const r = this.registerOrTypeQ(TYPE_LOCAL);
        if (!r.f) return;
        const { id: sym, t } = this.parseDeclarator(r.t);
        const p = this.paramOk(t);
        if (p !== null) { sym.value = this.cg.dynAllot(2); sym.type = p; }
        if (!this.comesChar(',')) return;
      }
    } finally {
      this.handleIdFn = saved;
    }
  }

  parametersClose() {                     // [parameters])
    this.cg.dynReset();
    if (this.comesChar(')')) return;
    if (this.tw().type === T.ID) this.idParameters();
    else this.typedParameters();
    this.expectChar(')');
  }

  parseDeclarator(t) {                    // (declarator ( type -- id-handle type' )
    this.nObj = 1;
    this.dimd = false;
    let ptr = false;
    while (this.comesOp('*')) {
      if (ptr) this.error('double pointer');
      ptr = true;
    }
    let id;
    if (this.comesChar('(')) {
      const inner = this.parseDeclarator(t);
      id = inner.id; t = inner.t;
      this.expectChar(')');
    } else {
      id = this.handleIdFn();
    }
    for (;;) {
      const m = this.s.mark();
      if (this.comesChar('[')) t = this.handleArray(t);
      if (this.comesChar('(')) t = this.handleFunction(t);
      if (!this.s.advanced(m)) break;
    }
    if (ptr) t = this.setPointer(t);
    return { id, t };
  }

  declarator(t, first) {
    this.isFirst = first;
    const { id, t: t2 } = this.parseDeclarator(t);
    if (!functionQ(t2) && is(t2, T_FASTCALL)) this.error('_fastcall on non-function');
    this.declaratorFn(id, t2);
  }

  declaratorList(t) {                     // declarator-list';'
    this.functionDefined = false;
    this.declarator(t, true);
    if (this.functionDefined) return;
    while (this.comesChar(',')) this.declarator(t, false);
    this.expectChar(';');
  }

  // ---- data definitions ----
  checkTypesEqual(t1, t2) {
    if (((t1 ^ t2) & DECL_MASK) !== 0) this.error('type mismatch');
  }

  declare(id, t) {
    const sym = this.symtab.findglobal(id);
    if (sym) this.checkTypesEqual(t, sym.type);
    else this.error(`undefined: ${id}`);
  }

  defineExtern(id, t) {                   // <name> *= <addr>
    if (functionQ(t)) this.symtab.unnestlocal();
    const sym = this.symtab.putglobal(id);
    sym.value = this.constantExpression();
    sym.type = t;
  }

  dimArray(t) {
    if (!this.dimd) {
      if (this.initd) this.nObj = this.nInits;
      else t |= T_LVALUE;
    }
    return t;
  }

  oneInit(v) { this.initValues.push(v & 0xffff); this.nInits++; }

  initBraces() {                          // init[]
    for (;;) {
      this.oneInit(this.constantExpression());
      if (this.comesChar('}')) return;
      this.expectChar(',');
      if (this.comesChar('}')) { this.oneInit(0); return; }
    }
  }

  staticInit(t) {
    const charT = isChar(t), arrT = arrayQ(t);
    const w = this.tw();
    if (w.type === T.STRING) {
      if (!(charT && arrT)) this.error('type mismatch in initializer');
      this.initd = true;
      for (const b of w.value) this.oneInit(b);   // includes the trailing 0
      this.accept();
      return;
    }
    if (this.comesChar('{')) {
      if (!arrT) this.error('type mismatch in initializer');
      this.initd = true;
      this.initBraces();
      return;
    }
    this.oneInit(this.constantExpression());
  }

  createStatic(t) {
    const sz = elemSize(t);
    const emit = sz === 1
      ? (b) => this.statics.cstat(b)
      : (wd) => this.statics.stat(wd);
    if (this.nInits > this.nObj) {
      this.error('too many initializers');
      this.initValues.length = this.nObj;
      this.nInits = this.nObj;
    }
    for (let i = this.nInits; i < this.nObj; i++) emit(0);
    for (let i = this.nInits - 1; i >= 0; i--) emit(this.initValues[i]);
    return { v: this.statics.addr, t };
  }

  createDyn(t) {
    return { v: this.cg.dynAllot(elemSize(t) * this.nObj), t };
  }

  defineData(id, t) {
    if (this.externFlag) { this.declare(id, t); return; }
    this.nInits = 0;
    this.initd = false;
    this.initValues = [];
    let obj;
    if (is(t, T_OFFSET)) {                          // local
      if (arrayQ(t)) t = this.dimArray(t);
      obj = this.createDyn(t);
      if (this.comesOp('=')) {
        this.exprToAccu();
        this.v['.size'](elemSize(obj.t));
        this.v['.sta.s(base),#'](obj.v);
      }
    } else {                                        // global/static
      if (this.comesOp('=')) this.staticInit(t);
      if (arrayQ(t)) t = this.dimArray(t);
      obj = this.createStatic(t);
    }
    const sym = this.putSymbolFn(id);
    sym.value = obj.v;
    sym.type = obj.t;
  }

  // ---- function definitions & prototypes ----
  prototype(id, t) {
    this.symtab.unnestlocal();              // parameter scope
    const existing = this.symtab.findglobal(id);
    if (existing) { this.checkTypesEqual(t, existing.type); return; }
    const label = this.v['.label']();
    const sym = this.symtab.putglobal(id);
    sym.value = label;
    sym.type = t | T_PROTO;
    const jmp = this.v['.jmp-ahead']();     // the stub calls will jsr to
    this.protosResolve.set(sym, jmp + 1);   // operand address
  }

  findPutGlobal(id, obj) {                  // find/putglobal + adjust-prototype
    const sym = this.symtab.findglobal(id);
    if (sym && is(sym.type, T_PROTO)) {
      this.checkTypesEqual(obj.t, sym.type);
      const opAddr = this.protosResolve.get(sym);
      if (opAddr === undefined) throw new CompileFatal('proto without patch record');
      this.protosResolve.delete(sym);
      this.patches.push({ addr: opAddr, target: obj.v });
      return sym;
    }
    return this.symtab.putglobal(id);       // double-def diagnosed there
  }

  declareParameters() {
    this.declaratorFn = (id, t) => this.parameterDecl(id, t);
    for (;;) {
      const r = this.registerOrTypeQ(TYPE_LOCAL);
      if (!r.f) return;
      this.declaratorList(r.t);
    }
  }

  parameterDecl(id, t) {                    // parameter'
    const p = this.paramOk(t);
    if (p === null) return;
    const sym = this.symtab.findlocal(id);
    if (!sym) this.error(`undefined parameter: ${id}`);
    else sym.type = p;
  }

  defineFunction(id, t) {
    const w = this.tw();
    if (w.type === T.CHAR && (w.ch === ';' || w.ch === ',')) {
      this.prototype(id, t);
      return;
    }
    if (!this.isFirst) { this.error('syntax error'); return; }
    if (is(t, T_FASTCALL)) this.error('_fastcall functions cannot be defined in C');
    const label = this.v['.label']();
    const sym = this.findPutGlobal(id, { v: label, t });
    sym.value = label;
    sym.type = t;
    this.declareParameters();
    this.expectChar('{');
    this.compound();
    this.symtab.unnestlocal();              // parameter scope
    this.v['.rts']();
    this.functionDefined = true;
  }

  // ---- declaration drivers ----
  declarationDecl(id, t) {                  // declaration' (inside functions)
    if (functionQ(t)) {
      this.symtab.unnestlocal();
      this.declare(id, (t & ~T_OFFSET) | T_EXTERN);
    } else {
      this.putSymbolFn = (n) => this.symtab.putlocal(n);
      this.defineData(id, t);
    }
  }

  definitionDecl(id, t) {                   // definition' (top level)
    if (this.comesOp('*=')) { this.defineExtern(id, t); return; }
    if (functionQ(t)) this.defineFunction(id, t);
    else {
      this.putSymbolFn = (n) => this.symtab.putglobal(n);
      this.defineData(id, t);
    }
  }

  declarationQ() {
    this.declaratorFn = (id, t) => this.declarationDecl(id, t);
    const r = this.classOrTypeQ(TYPE_LOCAL);
    if (!r.f) return false;
    this.declaratorList(r.t);
    return true;
  }

  definitionQ() {
    this.declaratorFn = (id, t) => this.definitionDecl(id, t);
    const r = this.rangeOrTypeQ(TYPE_GLOBAL);
    if (r.f) { this.declaratorList(r.t); return true; }
    if (this.tw().type === T.EOF) return false;
    const m = this.s.mark();
    this.declaratorList(r.t);
    return this.s.advanced(m);
  }

  compound() {
    this.symtab.nestlocal();
    while (this.declarationQ());
    while (this.statementQ());
    this.expectChar('}');
    this.symtab.unnestlocal();
  }

  // ---- entry point ----
  compileProgram() {
    while (this.definitionQ());
    const main = this.symtab.findglobal('main');
    let mainAddr = 0;
    if (main) {
      if (!functionQ(main.type)) throw new CompileFatal('main is not a function');
      mainAddr = main.value;
    }
    return { mainAddr, patches: this.patches };
  }
}
