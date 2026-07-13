// Preprocessor — port of preprocessor.fth ("a really bad hack", per its own
// header comment, and faithfully so).
//
// It is a *line source* for the Scanner: lines whose first column is '#'
// are consumed as directives (unless the scanner is inside a /* */ comment),
// everything else passes through. Directives take effect at their position
// in the stream, which matters because compilation is single-pass:
//
//   #include "name" | <name>  — pushes the file onto the include stack
//   #define name [-]number    — creates a *global constant* in the symbol
//                               table (no macro substitution at all); type
//                               is int if the value has high-byte bits,
//                               char otherwise, with the %extern flag set
//   #pragma cc64 f z l r c s S name — configures the runtime module layout
//
// Directive errors are reported via diag() and the line is skipped, like
// the original's cpp-error/clearline.

import { KEYWORDS, ID_MAX } from './scanner.js';

// type-cell encoding used by cpp-define (see preprocessor.fth block 107):
// bit 0 = int (vs char), $2000 = %extern
const TYPE_EXTERN = 0x2000;

export class Preprocessor {
  constructor({ fs = new Map(), symtab, diag = (msg) => { throw new Error(msg); } }) {
    this.fs = fs;             // virtual filesystem: name -> string
    this.symtab = symtab;
    this.diag = diag;
    this.stack = [];          // include stack: {name, lines, idx}
    this.scanner = null;      // wired after Scanner construction
    this.layout = null;       // set by #pragma cc64 (codelayout.ok)
  }

  pushFile(name, text) {
    if (this.stack.length > 7) { this.error(`#include nested too deep: ${name}`); return; }
    this.stack.push({ name, lines: text.split('\n'), idx: 0 });
  }

  openInclude(name) {
    const text = this.fs.get(name);
    if (text == null) { this.error(`#include: file not found: ${name}`); return; }
    this.pushFile(name, typeof text === 'string' ? text : new TextDecoder('latin1').decode(text));
  }

  where() {
    const top = this.stack[this.stack.length - 1];
    return top ? `${top.name}:${top.idx}` : '?';
  }

  error(msg) { this.diag(`${msg} (${this.where()})`); }

  // ---- line source interface for the Scanner ----
  nextLine() {
    for (;;) {
      const top = this.stack[this.stack.length - 1];
      if (!top) return null;
      if (top.idx >= top.lines.length) { this.stack.pop(); continue; }
      const line = top.lines[top.idx++];
      if (line[0] === '#' && !this.scanner?.inComment) {
        this.directive(line.slice(1));
        continue;
      }
      return line;
    }
  }

  // ---- directives ----
  directive(rest) {
    const p = new LineParser(rest);
    const word = p.word();
    if (word === 'include') this.cppInclude(p);
    else if (word === 'define') this.cppDefine(p);
    else if (word === 'pragma') this.cppPragma(p);
    else this.error(`unknown preprocessor directive: #${word}`);
  }

  cppInclude(p) {
    p.skipBlanks();
    const open = p.next();
    const close = open === '<' ? '>' : open === '"' ? '"' : null;
    if (!close) { this.error('#include expects <name> or "name"'); return; }
    const name = p.until(close);
    if (name === null || name.length === 0) { this.error('#include: bad filename'); return; }
    this.openInclude(name);
  }

  cppDefine(p) {
    p.skipBlanks();
    const name = p.identifier();
    if (!name) { this.error('#define expects an identifier'); return; }
    if (KEYWORDS.includes(name)) { this.error(`#define of keyword: ${name}`); return; }
    if (p.peek() !== '' && p.peek() !== ' ' && p.peek() !== '\t') {
      this.error(`#define ${name}: junk after identifier`); return;
    }
    p.skipBlanks();
    let sign = 1;
    if (p.peek() === '-') { p.next(); sign = -1; }
    const n = p.number();
    if (n === null) { this.error(`#define ${name}: numeric value expected`); return; }
    const value = (sign * n) & 0xffff;
    const sym = this.symtab.putglobal(name);
    // "Hack: Set type to %char or %int, with %extern set." — cpp-define
    sym.type = ((value & 0xff00) !== 0 ? 1 : 0) | TYPE_EXTERN;
    sym.value = value;
    // rest of line ignored (clearline)
  }

  cppPragma(p) {
    if (p.word() !== 'cc64') { this.error('#pragma: only "#pragma cc64" is known'); return; }
    const nums = [];
    for (let i = 0; i < 7; i++) {
      p.skipBlanks();
      const n = p.number();
      if (n === null) { this.error(`#pragma cc64: number ${i + 1} of 7 missing`); return; }
      nums.push(n);
    }
    const moduleName = p.word();
    if (!moduleName) { this.error('#pragma cc64: module name missing'); return; }
    const [frame, zp, libFirst, runtimePtr, codeFirst, staticsLibFirst, staticsLast] = nums;
    this.layout = {
      frame, zp, libFirst, runtimePtr,
      codeFirst,                 // module code.last == where new code starts (*=)
      staticsLibFirst,           // module statics.first == where new statics start
      staticsLast,
      moduleName,
      libCodeName: `${moduleName}.o`,
      libInitName: `${moduleName}.i`,
    };
  }
}

// small helper mirroring the cpp-nextword / cpp-number? line parsing
class LineParser {
  constructor(text) { this.text = text; this.pos = 0; }
  peek() { return this.pos < this.text.length ? this.text[this.pos] : ''; }
  next() { const c = this.peek(); if (c !== '') this.pos++; return c; }
  skipBlanks() { while (this.peek() === ' ' || this.peek() === '\t') this.pos++; }

  word() { // up to blank/EOL (cpp-nextword)
    this.skipBlanks();
    let w = '';
    while (this.peek() !== '' && this.peek() !== ' ' && this.peek() !== '\t') w += this.next();
    return w;
  }

  identifier() {
    if (!/[a-zA-Z_]/.test(this.peek())) return null;
    let w = '';
    while (/[a-zA-Z0-9_]/.test(this.peek())) w += this.next();
    return w.slice(0, ID_MAX);
  }

  until(ch) {
    const idx = this.text.indexOf(ch, this.pos);
    if (idx === -1) return null;
    const out = this.text.slice(this.pos, idx);
    this.pos = idx + 1;
    return out;
  }

  number() { // scanner number syntax: 0x hex, 0 octal, decimal
    if (!/[0-9]/.test(this.peek())) return null;
    let v = 0;
    if (this.peek() === '0') {
      this.next();
      if (this.peek().toLowerCase() === 'x') {
        this.next();
        while (/[0-9a-fA-F]/.test(this.peek())) v = (v * 16 + parseInt(this.next(), 16)) & 0xffff;
      } else {
        while (/[0-7]/.test(this.peek())) v = (v * 8 + (this.next().charCodeAt(0) - 48)) & 0xffff;
      }
    } else {
      while (/[0-9]/.test(this.peek())) v = (v * 10 + (this.next().charCodeAt(0) - 48)) & 0xffff;
    }
    return v;
  }
}
