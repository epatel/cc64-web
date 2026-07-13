// #pragma cc64 parsing — the runtime-module interface line found in module
// .h files, e.g. assets/rt/rt-c64-08-9f.h:
//   #pragma cc64 0xfd 0xfb 0x801 0x840 0x9ee 0x9ffe 0xa000 rt-c64-08-9f
// Field order matches minilinker.fth's write-libheader:
//   >frame >zp lib.first >runtime code.last statics.first statics.last name

function cnum(tok) {
  if (/^0x/i.test(tok)) return parseInt(tok.slice(2), 16);
  if (/^\$/.test(tok)) return parseInt(tok.slice(1), 16);
  if (/^0[0-7]+$/.test(tok)) return parseInt(tok, 8);
  return parseInt(tok, 10);
}

export function parsePragma(text) {
  const m = text.match(/^#pragma\s+cc64\s+(.+)$/m);
  if (!m) throw new Error('no "#pragma cc64" line found');
  const parts = m[1].trim().split(/\s+/);
  if (parts.length !== 8) throw new Error(`#pragma cc64 expects 7 numbers + module name, got ${parts.length} fields`);
  const nums = parts.slice(0, 7).map(cnum);
  if (nums.some(Number.isNaN)) throw new Error(`bad number in #pragma cc64: ${m[1]}`);
  const [frame, zp, libFirst, runtimePtr, codeLast, staticsFirst, staticsLast] = nums;
  return { frame, zp, libFirst, runtimePtr, codeLast, staticsFirst, staticsLast, moduleName: parts[7] };
}
