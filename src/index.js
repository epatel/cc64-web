// cc64-web public API.
//
// Compiler (JS reimplementation of cc64) — see docs/PLAN.md:
export { Scanner, tokenize, T, KEYWORDS, OPS, OP } from './scanner.js';
export { parsePragma } from './pragma.js';
export { linkExecutable, dissectExecutable, LinkError } from './linker.js';
export { SymTab } from './symtab.js';
export { Preprocessor } from './preprocessor.js';
export { makeFrontend } from './frontend.js';

// Oracle / disk-image support (used by tools/oracle/ to produce reference
// PRGs with the real cc64 running in VICE):
import { D64, FILETYPE } from './d64.js';
import { textToPetscii, petsciiToText } from './petscii.js';

export { D64, FILETYPE, textToPetscii, petsciiToText };

// Inject C sources (as PETSCII SEQ files) into a copy of cc64-c64files.d64.
export function buildCompileDisk(baseImage, sources) {
  const disk = new D64(baseImage);
  for (const { name, text } of sources) {
    if (name.length > 16) throw new Error(`CBM filenames are max 16 chars: ${name}`);
    disk.writeFile(name.toLowerCase(), textToPetscii(text), FILETYPE.SEQ);
  }
  return disk.toBytes();
}

// After cc64 ran `cc name.c`, the executable PRG is named like the source
// minus ".c"; bytes include the 2-byte load address.
export function extractPrg(image, sourceName) {
  const disk = new D64(image);
  return disk.readFile(sourceName.toLowerCase().replace(/\.c$/, ''));
}

export function extractLog(image, logName) {
  const disk = new D64(image);
  return petsciiToText(disk.readFile(logName));
}

export { amalgamate } from './amalgamate.js';
