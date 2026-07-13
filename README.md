# cc64-web

A JavaScript reimplementation of [cc64](https://github.com/pzembrod/cc64) —
Philip Zembrod's small-C compiler for the Commodore 64 — so it runs natively
in the browser and produces standard C64 `.prg` files that can be handed to
[Web64](https://web64.nofs.ai/ide/) (Mika Jussila's browser VICE port) or any
other emulator.

The original cc64 is 6502 machine code (written in VolksForth) that runs *on*
the C64; there is nothing to "compile to WASM". This project rebuilds the
compiler pipeline — scanner, preprocessor, parser, code generator, minilinker
— in portable ESM JavaScript, reusing cc64's release runtime modules
(`assets/rt/`: `rt-c64-08-9f.o/.i/.h`, `libc-c64.*`) as binary inputs, so the
output is a real cc64-style PRG (runtime module + generated code + init data,
load address $0801).

See **docs/PLAN.md** for the architecture, the Forth→JS port map, fidelity
rules, and milestones.

## Status

- ✅ Scanner (`src/scanner.js`) — faithful port of `scanner.fth`: cc64's
  keyword and operator sets, hex/octal/decimal numbers, `/* */` comments,
  char/string literals emitted as PETSCII bytes (`\n` = CR 13).
- ✅ Minilinker (`src/linker.js`, `src/pragma.js`) — port of
  `minilinker.fth`'s executable path: module .o/.i composition, the 8-byte
  runtime interface patch (main, code.last, statics bounds), forward-call
  fixups, reversed init data. `dissectExecutable()` splits a linked PRG back
  into parts; three oracle-produced golden PRGs (helloworld, sieve,
  printf/libc) **round-trip byte-identical** (`node test/linker.test.mjs`).
- ✅ Preprocessor + symbol table (`src/preprocessor.js`, `src/symtab.js`,
  wired by `src/frontend.js`) — the scanner is line-based like the
  original's `input.fth`; the preprocessor is its line source, handling the
  `#include` stack, `#define`-as-constant (no macros, by design), and
  `#pragma cc64` module layout, with directives inside `/* */` ignored.
  The symbol table mirrors `symboltable.fth`'s scoping: double definitions
  rejected only within the current `{}` block, innermost-first lookup,
  31-char name significance. All fixtures flow through the front end with
  the real `rt-c64`/`libc-c64` headers, zero diagnostics.
- ✅ v-assembler (`src/vasm.js`) — cc64's 6502 code-template engine (the
  virtual 16-bit accumulator machine: A/X pair, hardware stack for
  intermediates, `>zp` scratch, `>frame` locals pointer). Every template is
  ported to emit the original's exact bytes — 75 byte-level pins, and 13
  template signatures verified to appear verbatim inside the golden PRGs
  produced by real cc64 (including `.pop-zp`, `.cmp-zp`, `.neg`, `(.le`,
  and runtime calls through the `>runtime` jump table).
- ✅ Codegen + parser + driver (`src/codegen.js`, `src/parser.js`,
  `src/compile.js`) — the complete compiler. **Differentially verified:
  helloworld, sieve, printf (libc module) and a torture test (switch,
  function pointers, prototypes, `?:`, `&&`/`||`, pointer arithmetic)
  all compile byte-identical to real cc64's output.**
- ⬜ `link-lib` (library-module output for sources without `main()`) —
  the only unported piece; see PLAN.md.

## Differential-testing oracle

Real cc64 running headlessly in VICE is the reference implementation.
`tools/oracle/` contains a proven pipeline (verified end-to-end on this
machine, VICE 3.9): inject a C source into the cc64 release disk image,
boot cc64, compile at warp speed, extract the PRG.

```bash
CC64_REPO=<pzembrod/cc64 checkout> tools/oracle/cc64-compile.sh prog.c prog.prg
```

`helloworld-c64.c` → 747-byte PRG, load address $0801, byte-identical
whether compiled via disk image or host directory. Golden PRGs from the
oracle become the target for the JS compiler: same input, same bytes.

Support code: `src/d64.js` (1541 disk image read/write, validated against
VICE's `c1541`, `node test/d64.test.mjs`) and `src/petscii.js`
(ASCII↔PETSCII, ported from cc64's tools).

## Web page

```bash
npm run web    # -> http://localhost:8064/web/
```

`web/index.html` is the compiler UI, a small zero-dependency IDE:

- **Projects** — named workspaces (switcher at the top of the rail; create,
  rename, delete), each holding its own set of `.c`/`.h` files, persisted
  in localStorage. `#include "file.h"` resolves against the active
  project's files first, then the library.
- **Files rail** — the project's files (create/delete, `·c`/`·h` markers)
  plus a read-only Library section with the bundled cc64 headers
  (`rt-c64-08-9f.h`, `libc-c64.h`, ctype/stdio/stdlib/string).
- **Compile project (unity build)** — `src/amalgamate.js` concatenates all
  of the project's `.c` files (alphabetical), hoists every `#include` to
  the top, deduped in first-seen order (so the runtime header's
  `#pragma cc64` always precedes code, and headers with function bodies
  can't be double-included); includes inside `/* */` comments are ignored.
  The result compiles as one translation unit named `<project>.prg`.
  cc64's forward-call patching makes cross-file call order a non-issue.
- **Editor** — syntax highlighting driven by cc64's real keyword set
  (overlay technique, no dependencies), Tab inserts two spaces,
  Ctrl/Cmd+Enter compiles, and a Format button reindents by brace depth
  (string/comment aware).
- **Program panel** — the compiled/loaded PRG appears as a compact file
  row (name, size, load address) that doubles as the drag handle for the
  Web64 handoff. Compile runs the real pipeline (front end today; PRGs
  once parser/codegen land); until then the three oracle-built reference
  PRGs are available from the dropdown.

### Handoff to Web64

Web64 exposes no URL-parameter or postMessage intake (verified against its
deployed bundles) — its PRG import is file-based. So the page offers:
- **drag the 💾 chip** straight onto the Web64 IDE tab (Chromium's
  `DownloadURL` drag turns it into a real file drop), or
- **Download .prg** and use Web64 IDE's *Add files* / drag-drop.

Longer term: propose a `compilerBackend: "cc64"` (or a `#prg=` /
postMessage intake) to the Web64 author alongside its own `web64-native`
C backend.
