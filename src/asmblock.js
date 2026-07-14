// __asm { ... } block assembler (cc64-web extension — real cc64 has no
// inline assembly). Line-oriented 6502 assembly emitted at the current
// code address, inside a function body:
//
//   __asm {
//     lda m_a          ; C globals resolve to their addresses
//     ldy #<TABLE      ; #define constants resolve to their values
//     sta patch+1      ; local labels, +/- offsets (self-modifying code)
//   patch:
//     lda $c800,y
//     bne done
//   done:
//   }
//
// - one instruction per line; `label:` prefixes; `;` comments
// - operands: #imm, addr, addr,x  addr,y  (zp),y  (zp,x)  (ind), `a`
// - expressions: $hex 0xhex decimal, identifier, one +/- offset;
//   `<` / `>` take lo/hi byte (e.g. lda #>qtab)
// - identifiers: local labels first, then C globals/#defines via symtab;
//   unknown names are assumed to be forward local labels (16-bit)
// - zeropage addressing is chosen automatically for resolved values < $100
// - .byte e, e, ...  and .word e, e, ...  data directives
// - the closing `}` must sit on its own line
//
// The block clobbers A/X/Y/flags; cc64's statement level assumes nothing
// across statements, so no accumulator bookkeeping is needed.

const OPS = {
  adc: { imm: 0x69, zp: 0x65, zpx: 0x75, abs: 0x6d, absx: 0x7d, absy: 0x79, izx: 0x61, izy: 0x71 },
  and: { imm: 0x29, zp: 0x25, zpx: 0x35, abs: 0x2d, absx: 0x3d, absy: 0x39, izx: 0x21, izy: 0x31 },
  asl: { acc: 0x0a, zp: 0x06, zpx: 0x16, abs: 0x0e, absx: 0x1e },
  bcc: { rel: 0x90 }, bcs: { rel: 0xb0 }, beq: { rel: 0xf0 }, bmi: { rel: 0x30 },
  bne: { rel: 0xd0 }, bpl: { rel: 0x10 }, bvc: { rel: 0x50 }, bvs: { rel: 0x70 },
  bit: { zp: 0x24, abs: 0x2c },
  brk: { imp: 0x00 },
  clc: { imp: 0x18 }, cld: { imp: 0xd8 }, cli: { imp: 0x58 }, clv: { imp: 0xb8 },
  cmp: { imm: 0xc9, zp: 0xc5, zpx: 0xd5, abs: 0xcd, absx: 0xdd, absy: 0xd9, izx: 0xc1, izy: 0xd1 },
  cpx: { imm: 0xe0, zp: 0xe4, abs: 0xec },
  cpy: { imm: 0xc0, zp: 0xc4, abs: 0xcc },
  dec: { zp: 0xc6, zpx: 0xd6, abs: 0xce, absx: 0xde },
  dex: { imp: 0xca }, dey: { imp: 0x88 },
  eor: { imm: 0x49, zp: 0x45, zpx: 0x55, abs: 0x4d, absx: 0x5d, absy: 0x59, izx: 0x41, izy: 0x51 },
  inc: { zp: 0xe6, zpx: 0xf6, abs: 0xee, absx: 0xfe },
  inx: { imp: 0xe8 }, iny: { imp: 0xc8 },
  jmp: { abs: 0x4c, ind: 0x6c },
  jsr: { abs: 0x20 },
  lda: { imm: 0xa9, zp: 0xa5, zpx: 0xb5, abs: 0xad, absx: 0xbd, absy: 0xb9, izx: 0xa1, izy: 0xb1 },
  ldx: { imm: 0xa2, zp: 0xa6, zpy: 0xb6, abs: 0xae, absy: 0xbe },
  ldy: { imm: 0xa0, zp: 0xa4, zpx: 0xb4, abs: 0xac, absx: 0xbc },
  lsr: { acc: 0x4a, zp: 0x46, zpx: 0x56, abs: 0x4e, absx: 0x5e },
  nop: { imp: 0xea },
  ora: { imm: 0x09, zp: 0x05, zpx: 0x15, abs: 0x0d, absx: 0x1d, absy: 0x19, izx: 0x01, izy: 0x11 },
  pha: { imp: 0x48 }, php: { imp: 0x08 }, pla: { imp: 0x68 }, plp: { imp: 0x28 },
  rol: { acc: 0x2a, zp: 0x26, zpx: 0x36, abs: 0x2e, absx: 0x3e },
  ror: { acc: 0x6a, zp: 0x66, zpx: 0x76, abs: 0x6e, absx: 0x7e },
  rti: { imp: 0x40 }, rts: { imp: 0x60 },
  sbc: { imm: 0xe9, zp: 0xe5, zpx: 0xf5, abs: 0xed, absx: 0xfd, absy: 0xf9, izx: 0xe1, izy: 0xf1 },
  sec: { imp: 0x38 }, sed: { imp: 0xf8 }, sei: { imp: 0x78 },
  sta: { zp: 0x85, zpx: 0x95, abs: 0x8d, absx: 0x9d, absy: 0x99, izx: 0x81, izy: 0x91 },
  stx: { zp: 0x86, zpy: 0x96, abs: 0x8e },
  sty: { zp: 0x84, zpx: 0x94, abs: 0x8c },
  tax: { imp: 0xaa }, tay: { imp: 0xa8 }, tsx: { imp: 0xba },
  txa: { imp: 0x8a }, txs: { imp: 0x9a }, tya: { imp: 0x98 },
};

const NUM = /^(?:\$([0-9a-f]+)|0x([0-9a-f]+)|(\d+))$/i;
const ID = /^[a-z_]\w*$/i;

// expr := ['<' | '>'] term [('+'|'-') number] ; term := number | identifier
// returns { v } when resolved, { fwd: name, ofs, part } for a forward label
function parseExpr(text, labels, resolve, err) {
  let part = null;
  let s = text.trim();
  if (s[0] === '<' || s[0] === '>') { part = s[0]; s = s.slice(1).trim(); }
  const m = s.match(/^(.*?)\s*([+-])\s*([^+-]+)$/);
  let term = s, ofs = 0;
  if (m && !NUM.test(s)) {                       // one +/- offset (not "2-1")
    term = m[1].trim();
    const n = numval(m[3].trim());
    if (n === null) return err(`bad offset: ${text}`);
    ofs = m[2] === '-' ? -n : n;
  }
  const apply = (v) => {
    v = (v + ofs) & 0xffff;
    return part === '<' ? v & 0xff : part === '>' ? (v >> 8) & 0xff : v;
  };
  const n = numval(term);
  if (n !== null) return { v: apply(n) };
  if (!ID.test(term)) return err(`bad expression: ${text}`);
  if (labels.has(term)) return { v: apply(labels.get(term)) };
  const g = resolve(term);
  if (g !== null) return { v: apply(g) };
  return { fwd: term, ofs, part };               // assume forward local label
}

function numval(s) {
  const m = s.match(NUM);
  if (!m) return null;
  return parseInt(m[1] ?? m[2] ?? m[3], m[3] !== undefined ? 10 : 16) & 0xffff;
}

export function assembleBlock(rawLines, { code, resolve, error }) {
  const labels = new Map();
  const fixups = [];                             // {at, kind, name, ofs, part, line}
  let bad = false;
  let lineNo = 0;
  const err = (msg) => { error(`__asm: ${msg} (line ${lineNo})`); bad = true; return null; };

  const operandByte = (e, kind) => {             // emit one operand byte (fixup-able)
    if (e.v !== undefined) {
      if (kind === 'rel') {
        const off = e.v - (code.pc + 1);
        if (off < -128 || off > 127) err(`branch out of range (${off})`);
        code.b(off & 0xff);
      } else code.b(e.v);
    } else {
      fixups.push({ at: code.pc, kind, ...e, line: lineNo });
      code.b(0);
    }
  };
  const operandWord = (e) => {
    if (e.v !== undefined) code.w(e.v);
    else { fixups.push({ at: code.pc, kind: 'abs', ...e, line: lineNo }); code.w(0); }
  };

  for (const { text, line } of rawLines) {
    lineNo = line;
    let s = text;
    const sc = s.indexOf(';');
    if (sc >= 0) s = s.slice(0, sc);
    s = s.trim();
    // labels (possibly several, possibly followed by an instruction)
    for (let m; (m = s.match(/^([a-z_]\w*):\s*/i)); s = s.slice(m[0].length)) {
      if (labels.has(m[1])) err(`duplicate label: ${m[1]}`);
      labels.set(m[1], code.pc);
    }
    if (!s) continue;

    if (s[0] === '.') {                          // .byte / .word
      const dm = s.match(/^\.(byte|word)\s+(.*)$/i);
      if (!dm) { err(`unknown directive: ${s}`); continue; }
      for (const part of dm[2].split(',')) {
        const e = parseExpr(part, labels, resolve, err);
        if (!e) continue;
        if (dm[1].toLowerCase() === 'byte') {
          if (e.v === undefined) { err(`.byte needs a resolved value: ${part.trim()}`); continue; }
          if (e.v > 0xff) err(`.byte value > 255: ${part.trim()}`);
          code.b(e.v);
        } else operandWord(e);
      }
      continue;
    }

    const im = s.match(/^([a-z]{3})\s*(.*)$/i);
    const op = im && OPS[im[1].toLowerCase()];
    if (!op) { err(`unknown instruction: ${s}`); continue; }
    let arg = (im[2] ?? '').trim();

    const emit = (mode, e, width) => {
      code.b(op[mode]);
      if (width === 1) operandByte(e, mode === 'rel' ? 'rel' : 'zp');
      else if (width === 2) operandWord(e);
    };
    const zpOrAbs = (zpMode, absMode, e, what) => {
      if (e.v !== undefined && e.v < 0x100 && op[zpMode] !== undefined) emit(zpMode, e, 1);
      else if (op[absMode] !== undefined) emit(absMode, e, 2);
      else err(`bad addressing for ${im[1]} ${what}`);
    };

    if (arg === '' || (/^a$/i.test(arg) && op.acc !== undefined)) {
      const mode = arg === '' ? (op.imp !== undefined ? 'imp' : 'acc') : 'acc';
      if (op[mode] === undefined) { err(`missing operand: ${s}`); continue; }
      code.b(op[mode]);
      continue;
    }
    let m;
    if (arg[0] === '#') {
      const e = parseExpr(arg.slice(1), labels, resolve, err);
      if (!e) continue;
      if (e.v === undefined) { err(`immediate needs a resolved value: ${arg}`); continue; }
      if (e.v > 0xff) { err(`immediate > 255: ${arg} (use #< or #>)`); continue; }
      if (op.imm === undefined) { err(`no immediate mode for ${im[1]}`); continue; }
      emit('imm', e, 1);
    } else if ((m = arg.match(/^\((.+),\s*x\)$/i))) {
      const e = parseExpr(m[1], labels, resolve, err);
      if (!e) continue;
      if (e.v === undefined || e.v > 0xff || op.izx === undefined) { err(`bad (zp,x): ${arg}`); continue; }
      emit('izx', e, 1);
    } else if ((m = arg.match(/^\((.+)\),\s*y$/i))) {
      const e = parseExpr(m[1], labels, resolve, err);
      if (!e) continue;
      if (e.v === undefined || e.v > 0xff || op.izy === undefined) { err(`bad (zp),y: ${arg}`); continue; }
      emit('izy', e, 1);
    } else if ((m = arg.match(/^\((.+)\)$/))) {
      const e = parseExpr(m[1], labels, resolve, err);
      if (!e) continue;
      if (op.ind === undefined) { err(`no (indirect) mode for ${im[1]}`); continue; }
      emit('ind', e, 2);
    } else if ((m = arg.match(/^(.+),\s*x$/i))) {
      const e = parseExpr(m[1], labels, resolve, err);
      if (e) zpOrAbs('zpx', 'absx', e, arg);
    } else if ((m = arg.match(/^(.+),\s*y$/i))) {
      const e = parseExpr(m[1], labels, resolve, err);
      if (e) zpOrAbs('zpy', 'absy', e, arg);
    } else {
      const e = parseExpr(arg, labels, resolve, err);
      if (!e) continue;
      if (op.rel !== undefined) emit('rel', e, 1);
      else zpOrAbs('zp', 'abs', e, arg);
    }
  }

  for (const f of fixups) {
    lineNo = f.line;
    if (!labels.has(f.fwd)) { err(`undefined symbol: ${f.fwd}`); continue; }
    let v = (labels.get(f.fwd) + f.ofs) & 0xffff;
    v = f.part === '<' ? v & 0xff : f.part === '>' ? (v >> 8) & 0xff : v;
    if (f.kind === 'rel') {
      const off = v - (f.at + 1);
      if (off < -128 || off > 127) { err(`branch out of range (${off})`); continue; }
      code.bAt(f.at, off & 0xff);
    } else if (f.kind === 'zp') {
      if (v > 0xff) { err(`zeropage operand > 255: ${f.fwd}`); continue; }
      code.bAt(f.at, v);
    } else code.wAt(f.at, v);
  }
  return !bad;
}
