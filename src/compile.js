// One-call compiler entry point: C source -> .prg bytes (the `cc` command
// from invoke.fth). fs must contain the headers as text AND the runtime
// module binaries (<module>.o / <module>.i) as Uint8Array.

import { makeFrontend } from './frontend.js';
import { VAsm, CodeBuffer } from './vasm.js';
import { Codegen, Statics } from './codegen.js';
import { Parser, CompileFatal } from './parser.js';
import { linkExecutable } from './linker.js';

export { CompileFatal };

export function compile({ source, fileName = 'main.c', fs = new Map() }) {
  const fe = makeFrontend({ source, fileName, fs });
  const diagnostics = fe.diagnostics;
  const error = (msg) => diagnostics.push(msg);

  // The scanner primes its first token in the constructor, which pulls lines
  // through the preprocessor — the #pragma cc64 of the first include has
  // been seen by the time parsing starts (matching the original, where the
  // pragma line is consumed before any token reaches the parser).
  const firstToken = fe.scanner.thisword();
  const layout = fe.pp.layout;
  if (!layout) {
    error(`no #pragma cc64 seen before "${firstToken.value ?? firstToken.type}" — include a runtime header like rt-c64-08-9f.h`);
    return { prg: null, diagnostics };
  }

  const code = new CodeBuffer(layout.codeFirst);          // *=
  const vasm = new VAsm(
    { zp: layout.zp, frame: layout.frame, runtimePtr: layout.runtimePtr },
    code,
  );
  const statics = new Statics();
  statics.setBase(layout.staticsLibFirst);                // >staticadr
  const cg = new Codegen({ vasm, symtab: fe.symtab, statics, layout, error });
  const parser = new Parser({ scanner: fe.scanner, symtab: fe.symtab, cg, vasm, statics, error });

  const { mainAddr, patches } = parser.compileProgram();

  // end-of-code
  const staticsFirst = statics.addr;
  const status = {
    diagnostics,
    layout,
    mainAddr,
    codeBytes: code.bytes.length,
    staticsBytes: statics.bytes.length,
  };
  if (diagnostics.length) return { prg: null, ...status };
  if (!mainAddr) {
    error('no main() — library modules (cc64 link-lib) are not supported yet');
    return { prg: null, ...status };
  }

  const moduleO = fs.get(layout.libCodeName);
  const moduleI = fs.get(layout.libInitName);
  if (!moduleO || !moduleI) {
    error(`runtime module binaries missing from fs: ${layout.libCodeName} / ${layout.libInitName}`);
    return { prg: null, ...status };
  }

  const prg = linkExecutable({
    pragma: {
      libFirst: layout.libFirst,
      runtimePtr: layout.runtimePtr,
      codeLast: layout.codeFirst,
      staticsFirst: layout.staticsLibFirst,
      staticsLast: layout.staticsLast,
    },
    moduleO: moduleO instanceof Uint8Array ? moduleO : new Uint8Array(moduleO),
    moduleI: moduleI instanceof Uint8Array ? moduleI : new Uint8Array(moduleI),
    code: code.toBytes(),
    codePatches: patches,
    mainAddr,
    staticsFirst,
    progInit: statics.toBytes(),
  });
  return { prg, ...status };
}
