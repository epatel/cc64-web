// Minilinker — port of minilinker.fth (link-exe path).
//
// Output PRG layout (matching link-runtimemodule / link-code / link-statics):
//   [load address = lib.first]                        (2 bytes, from module .o)
//   [module code lib.first .. >runtime]               (copied from .o)
//   [8-byte runtime interface, patched:]              (replaces .o bytes)
//       main() address, code.last, statics.first, statics.last  (4 LE words)
//   [module code >runtime+8 .. module code.last]      (copied from .o)
//   [generated code code.first .. code.last]          (forward calls patched)
//   [module static init values]                       (.i minus load address)
//   [program static init values]                      (reverse order, from codegen)
//
// The runtime module's startup code copies the appended init values downward
// into the statics area, which is why they are stored in reverse order.

export class LinkError extends Error {}

const lo = (v) => v & 0xff;
const hi = (v) => (v >> 8) & 0xff;

// pragma: parsed module interface (see pragma.js). In minilinker terms:
//   pragma.libFirst     = lib.first        pragma.runtimePtr = >runtime
//   pragma.codeLast     = module code end  = code.first for generated code
//   pragma.staticsFirst = statics.libfirst pragma.staticsLast = statics.last
export function linkExecutable({
  pragma,
  moduleO,            // Uint8Array: module .o file incl. 2-byte load address
  moduleI,            // Uint8Array: module .i file incl. 2-byte load address
  code,               // Uint8Array: generated code (starts at pragma.codeLast)
  codePatches = [],   // [{addr, target}] forward-call fixups, absolute addrs
  mainAddr,           // address of main()
  staticsFirst,       // lowest allocated static address after compilation
  progInit = new Uint8Array(0), // program static init values, reverse order
}) {
  const { libFirst, runtimePtr, codeLast: codeFirst, staticsFirst: staticsLibFirst, staticsLast } = pragma;

  const moduleCodeLen = codeFirst - libFirst;
  if (moduleO.length !== moduleCodeLen + 2) {
    throw new LinkError(`module .o size ${moduleO.length} != 2 + (code.last - lib.first) = ${moduleCodeLen + 2}`);
  }
  const libInitLen = staticsLast - staticsLibFirst;
  if (moduleI.length !== libInitLen + 2) {
    throw new LinkError(`module .i size ${moduleI.length} != 2 + (statics.last - statics.first) = ${libInitLen + 2}`);
  }
  const loadAddr = moduleO[0] | (moduleO[1] << 8);
  if (loadAddr !== libFirst) {
    throw new LinkError(`module .o load address $${loadAddr.toString(16)} != lib.first $${libFirst.toString(16)}`);
  }
  if (staticsFirst > staticsLibFirst) {
    throw new LinkError('statics.first above module statics');
  }

  const codeLastFinal = codeFirst + code.length;

  // checksize: dynamic memory between end of code (plus appended init data,
  // where the soft stack starts) and the statics area must leave >= $100.
  const staticsSize = staticsLast - staticsFirst;
  const freeDyn = (staticsFirst - staticsSize) - codeLastFinal;
  if (staticsLast > libFirst && freeDyn < 0x100) {
    throw new LinkError(`code too long: ${freeDyn} bytes of dynamic memory left`);
  }

  // generated code with forward-call patches applied
  const patched = Uint8Array.from(code);
  for (const { addr, target } of codePatches) {
    const off = addr - codeFirst;
    if (off < 0 || off + 1 >= patched.length) {
      throw new LinkError(`patch address $${addr.toString(16)} outside generated code`);
    }
    patched[off] = lo(target);
    patched[off + 1] = hi(target);
  }

  const headerOff = 2 + (runtimePtr - libFirst); // interface block offset in .o
  const out = new Uint8Array(moduleO.length + patched.length + libInitLen + progInit.length);
  let p = 0;

  out.set(moduleO.subarray(0, headerOff), p); p += headerOff;
  for (const v of [mainAddr, codeLastFinal, staticsFirst, staticsLast]) {
    out[p++] = lo(v); out[p++] = hi(v);
  }
  out.set(moduleO.subarray(headerOff + 8), p); p += moduleO.length - headerOff - 8;
  out.set(patched, p); p += patched.length;
  out.set(moduleI.subarray(2), p); p += libInitLen;
  out.set(progInit, p);

  return out;
}

// Inverse of linkExecutable: split a linked PRG back into its parts using
// the module pragma. Used for round-trip testing against oracle output and
// handy for inspecting real cc64 binaries.
export function dissectExecutable(prg, pragma) {
  const { libFirst, runtimePtr, codeLast: codeFirst, staticsFirst: staticsLibFirst, staticsLast } = pragma;
  const loadAddr = prg[0] | (prg[1] << 8);
  if (loadAddr !== libFirst) throw new LinkError(`load address $${loadAddr.toString(16)} != lib.first`);

  const headerOff = 2 + (runtimePtr - libFirst);
  const w = (o) => prg[o] | (prg[o + 1] << 8);
  const mainAddr = w(headerOff);
  const codeLastFinal = w(headerOff + 2);
  const staticsFirst = w(headerOff + 4);
  const staticsLastHdr = w(headerOff + 6);
  if (staticsLastHdr !== staticsLast) {
    throw new LinkError(`statics.last in header $${staticsLastHdr.toString(16)} != pragma $${staticsLast.toString(16)} — wrong module?`);
  }

  const moduleEnd = 2 + (codeFirst - libFirst);
  const codeEnd = moduleEnd + (codeLastFinal - codeFirst);
  const libInitLen = staticsLast - staticsLibFirst;
  const progInitLen = staticsLibFirst - staticsFirst;
  if (codeEnd + libInitLen + progInitLen !== prg.length) {
    throw new LinkError(`size mismatch: expected ${codeEnd + libInitLen + progInitLen}, PRG is ${prg.length}`);
  }

  return {
    mainAddr,
    codeLastFinal,
    staticsFirst,
    code: prg.subarray(moduleEnd, codeEnd),
    libInit: prg.subarray(codeEnd, codeEnd + libInitLen),
    progInit: prg.subarray(codeEnd + libInitLen),
  };
}
