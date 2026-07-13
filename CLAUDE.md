# cc64-web

JS reimplementation of pzembrod/cc64 — the small-C compiler that runs *on*
the Commodore 64 — compiling cc64's C dialect to C64 `.prg` binaries in the
browser, with handoff to Web64 (https://web64.nofs.ai). Pure ESM, zero
runtime dependencies.

Full architecture, Forth→JS port map, and status: @docs/PLAN.md

## Commands

- `make` — menu of all actions
- `npm test` — full suite; includes the differential test (`test/compile.test.mjs`)
- `npm run web` — dev server at http://localhost:8064/web/ (the IDE page)
- `CC64_REPO=<cc64 checkout> tools/oracle/cc64-compile.sh f.c f.prg` — reference compile via real cc64 in VICE

## The prime directive: byte-identity

Compiler output must be **byte-identical** to real cc64. Golden PRGs in
`test/fixtures/golden/` were produced by the oracle (cc64 running in local
VICE, `/Applications/vice-arm64-sdl2-3.9/`). Any codegen/parser change must
keep `test/compile.test.mjs` green. New language-feature work: write a
fixture, generate its golden via the oracle, then implement until identical.

## Pipeline (src/)

`preprocessor` (line source: #include stack, #define-as-constant, #pragma
cc64) → `scanner` (line-based, cc64 tokens) → `parser` + `codegen`
((val,type) objects, templates from `vasm`) → `linker` (module .o/.i +
patched runtime interface + reversed init data). `compile.js` is the one-call
driver; `amalgamate.js` does unity builds; `d64.js`/`petscii.js` support the
oracle.

## Gotchas (hard-won)

- String/char literals are PETSCII in output; `\n` = CR (13).
- `stat,` emits hi byte first — the init stream is reversed into memory.
- Pointer scaling in `+`/`-` applies to the LEFT operand only.
- Sources without `main()` are library modules — `link-lib` is NOT ported yet.
- VICE 3.9 flags: `-virtualdev8`, `+drive8truedrive`; segfaults under
  SDL_VIDEODRIVER=dummy on macOS (run with a real window).
