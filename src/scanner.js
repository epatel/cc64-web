// Scanner for cc64's small-C dialect — a faithful port of scanner.fth from
// pzembrod/cc64. Token kinds, keyword set, operator set, number syntax and
// escape handling mirror the original. One deliberate difference: the
// original streams PETSCII; we read ASCII/UTF-8 text and convert char and
// string literal bytes to PETSCII so the generated binaries match.
//
// Like the original (input.fth), the scanner is line-based: it pulls lines
// from a source object with nextLine() -> string|null. The preprocessor is
// such a source (it filters '#' directive lines); a plain string works too.
// Tokens never span lines; strings may continue on the next line only via
// a trailing backslash. While the scanner skips a /* */ comment it sets
// .inComment, which the preprocessor checks before treating '#' lines as
// directives (comment-state in the original).

import { ascii2petscii } from './petscii.js';

export const T = Object.freeze({
  CHAR: 0,     // single legal character: ( ) [ ] { } , ; : ?
  ID: 1,
  NUMBER: 2,
  KEYWORD: 3,
  OPER: 4,
  STRING: 5,
  EOF: -1,
});

export const KEYWORDS = [
  'do', 'if', 'for', 'int', 'auto', 'case', 'char', 'else', 'goto', 'break',
  'while', 'extern', 'return', 'static', 'switch', 'default', 'continue',
  'register', '_fastcall',
  '__zeropage', '__asm', '__sprite',   // cc64-web extensions (zp vars, inline asm, sprite data)
];

// operator token values in the original enum order (scanner.fth block 41)
export const OPS = [
  '++', '+=', '+', '--', '-=', '-', '*=', '*', '/=', '/*', '/',
  '%=', '%', '&=', '&&', '&', '|=', '||', '|', '^=', '^',
  '!=', '!', '==', '=', '<<=', '<<', '<=', '<', '>>=', '>>', '>=', '>', '~',
];
export const OP = Object.freeze(Object.fromEntries(OPS.map((o, i) => [o, i])));
const OPS_BY_LENGTH = [...OPS].sort((a, b) => b.length - a.length);

const LEGAL_CHARS = '()[]{},;:?';
export const ID_MAX = 31; // /id in the original

const ESCAPES = new Map([
  ['b', 8], ['t', 9], ['n', 13], ['f', 12], ['r', 13], ['0', 0],
  ['\\', 0x5c], ["'", 0x27], ['"', 0x22],
]);

export class ScanError extends Error {
  constructor(msg, line) { super(`${msg} (line ${line})`); this.line = line; }
}

class StringSource {
  constructor(text) { this.lines = text.split('\n'); this.i = 0; }
  nextLine() { return this.i < this.lines.length ? this.lines[this.i++] : null; }
}

export class Scanner {
  constructor(source) {
    this.source = typeof source === 'string' ? new StringSource(source) : source;
    this.line = '';
    this.col = 0;
    this.eof = false;
    this.lineNo = 0;
    this.inComment = false;
    this.wordNo = 0;               // word# for mark/advanced?
    this.nextline();
    this.current = this.scan();    // thisword lookahead
  }

  // ---- line/char plumbing ----
  nextline() {
    const l = this.source.nextLine();
    if (l === null) { this.eof = true; this.line = ''; }
    else this.line = l;
    this.col = 0;
    this.lineNo++;
  }

  atEol() { return this.col >= this.line.length; }
  peekc() { return this.atEol() ? '' : this.line[this.col]; }
  nextc() { const c = this.peekc(); if (c !== '') this.col++; return c; }

  // ---- public interface (mirrors thisword/accept/mark/advanced?) ----
  thisword() { return this.current; }
  accept() { this.wordNo++; this.current = this.scan(); return this.current; }
  mark() { return this.wordNo; }
  advanced(mark) { return this.wordNo !== mark; }

  // __asm/__sprite support: thisword() must be the already-scanned '{'. Returns the
  // raw source lines up to the first '}' outside a ';' comment (text after
  // ';' belongs to the comment, so "; t = { x }" is fine), then resumes
  // normal tokenizing after it. Raw lines bypass C tokenization entirely
  // (no PETSCII, no /* */).
  rawBlockLines() {
    const lines = [];
    let rest = this.line.slice(this.col);
    for (;;) {
      const sc = rest.indexOf(';');
      let idx = rest.indexOf('}');
      if (sc >= 0 && idx > sc) idx = -1;
      if (idx >= 0) {
        if (rest.slice(0, idx).trim()) lines.push({ text: rest.slice(0, idx), line: this.lineNo });
        this.col = this.line.length - rest.length + idx + 1;   // past the '}'
        this.wordNo++;
        this.current = this.scan();
        return lines;
      }
      lines.push({ text: rest, line: this.lineNo });
      if (this.eof) throw new ScanError('unterminated raw block (__asm/__sprite)', this.lineNo);
      this.nextline();
      rest = this.line;
    }
  }

  // ---- scanning ----
  scan() {
    for (;;) {
      if (this.atEol()) {
        if (this.eof) return { type: T.EOF, value: -1, line: this.lineNo };
        this.nextline();
        continue;
      }
      const c = this.peekc();
      if (c === ' ' || c === '\t' || c === '\r') { this.col++; continue; }

      if (/[a-zA-Z_]/.test(c)) return this.identifier();
      if (/[0-9]/.test(c)) return this.number();

      const op = this.operator();
      if (op) {
        if (op === '/*') { this.skipComment(); continue; }
        return { type: T.OPER, value: OP[op], op, line: this.lineNo };
      }
      if (c === '"') { this.col++; return { type: T.STRING, value: this.stringLiteral(), line: this.lineNo }; }
      if (c === "'") { this.col++; return this.charConst(); }
      if (LEGAL_CHARS.includes(c)) { this.col++; return { type: T.CHAR, value: c.charCodeAt(0), ch: c, line: this.lineNo }; }
      throw new ScanError(`illegal character: ${JSON.stringify(c)}`, this.lineNo);
    }
  }

  identifier() {
    let name = '';
    while (/[a-zA-Z0-9_]/.test(this.peekc())) name += this.nextc();
    const truncated = name.slice(0, ID_MAX); // 31 chars significant
    const kw = KEYWORDS.indexOf(truncated);
    if (kw !== -1) return { type: T.KEYWORD, value: kw, kw: truncated, line: this.lineNo };
    return { type: T.ID, value: truncated, line: this.lineNo };
  }

  number() {
    let v = 0;
    if (this.peekc() === '0') {
      this.col++;
      if (this.peekc().toLowerCase() === 'x') {
        this.col++;
        while (/[0-9a-fA-F]/.test(this.peekc())) v = (v * 16 + parseInt(this.nextc(), 16)) & 0xffff;
      } else {
        while (/[0-7]/.test(this.peekc())) v = (v * 8 + (this.nextc().charCodeAt(0) - 48)) & 0xffff;
      }
    } else {
      while (/[0-9]/.test(this.peekc())) v = (v * 10 + (this.nextc().charCodeAt(0) - 48)) & 0xffff;
    }
    return { type: T.NUMBER, value: v, line: this.lineNo };
  }

  operator() {
    for (const op of OPS_BY_LENGTH) {
      if (this.line.startsWith(op, this.col)) {
        this.col += op.length;
        return op;
      }
    }
    return null;
  }

  skipComment() {
    // /* ... */ — the only comment form cc64 knows; may span lines
    const start = this.lineNo;
    this.inComment = true;
    try {
      for (;;) {
        if (this.atEol()) {
          if (this.eof) throw new ScanError('unterminated comment starting', start);
          this.nextline();
          continue;
        }
        if (this.nextc() === '*' && this.peekc() === '/') { this.col++; return; }
      }
    } finally {
      this.inComment = false;
    }
  }

  // one escaped-or-plain char as a C64 byte, or null for line continuation
  escapedChar() {
    let c = this.nextc();
    if (c !== '\\') return ascii2petscii(c.charCodeAt(0));
    if (this.atEol()) {                                  // \<eol>: continue on next line
      if (this.eof) throw new ScanError('unexpected EOF after backslash', this.lineNo);
      this.nextline();
      return null;
    }
    c = this.nextc();
    if (ESCAPES.has(c)) return ESCAPES.get(c);
    if (c >= '1' && c <= '7') {                          // octal, up to 3 digits
      let v = c.charCodeAt(0) - 48;
      for (let i = 0; i < 2 && /[0-7]/.test(this.peekc()); i++) {
        v = v * 8 + (this.nextc().charCodeAt(0) - 48);
      }
      return v & 0xff;
    }
    return ascii2petscii(c.charCodeAt(0));               // unknown escape: literal
  }

  charConst() {
    if (this.peekc() === "'" || this.atEol()) {
      throw new ScanError('bad character constant', this.lineNo);
    }
    const v = this.escapedChar();
    if (v === null || this.nextc() !== "'") throw new ScanError("missing closing '", this.lineNo);
    return { type: T.NUMBER, value: v & 0xff, line: this.lineNo };
  }

  stringLiteral() {
    // returns PETSCII bytes, zero-terminated like the original emits
    const bytes = [];
    for (;;) {
      if (this.atEol()) throw new ScanError('unterminated string', this.lineNo);
      if (this.peekc() === '"') { this.col++; break; }
      const b = this.escapedChar();
      if (b !== null) bytes.push(b);
    }
    bytes.push(0);
    return Uint8Array.from(bytes);
  }
}

// convenience: full tokenization of a plain string (no preprocessing)
export function tokenize(source) {
  const s = new Scanner(source);
  const out = [];
  while (s.thisword().type !== T.EOF) {
    out.push(s.thisword());
    s.accept();
  }
  return out;
}
