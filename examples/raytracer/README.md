# raytracer — mirror sphere over a checkered floor (cc64 C)

A C port of the assembly raytracer (`inspiration-raytracer/`): one shiny
sphere (mirror + Lambertian) over an infinite checkerboard, directional
light with cast shadows, sky darkening toward the horizon, Bayer-dithered
to 320x200 hires mono. Written in cc64's small-C dialect; all math is
signed 8.8 fixed point in 16-bit ints (`fixmath.c` — no float, no longs).

## Files

- `main.c` — video init (VIC bank 3: bitmap $e000 under the KERNAL ROM —
  the render path is write-only — screen $c400), row-based render loop,
  16x16 blue-noise dither (the asm original's table)
- `trace.c` — `trace_pixel`: half-b sphere quadratic, one-bounce mirror
  reflection, N·L diffuse, floor shadow ray, sky gradient
- `scene.h` — scene constants (8.8), with hand-derived `SPH_C2R`,
  `OCY_LY`, `CC_SH` (formulas in the header)
- `fixmath.c` — `fmul`/`fdiv`/`fsqrt`/`isqrt` under cc64 semantics
- `protos.h` — prototypes (the unity build is alphabetical, so cross-file
  calls need cc64's jmp-stub prototypes)

## Build

```bash
node examples/raytracer/mkproject.mjs
```

compile-checks with the real compiler, writes `raytracer.prg`, and joins
the sources into `raytracer.cc64proj.json` — import that in the cc64-web
page (⤒ button in the project bar) to get the whole thing as an editable
multi-file project. Run the PRG in Web64 with **warp on**.

Verified pixel-identical against a JS model of the algorithm by executing
the compiled PRG on `tools/run6502.mjs`.

## Performance log (`node tools/bench6502.mjs raytracer.prg`)

| version | cycles/frame | C64 time at 1x (PAL) |
|---|---|---|
| naive per-pixel trace | ~7.5 G (est.) | ~2h 7m |
| row constants, sphere x-band, byte plotting | 1.67 G | 28 min |
| table-of-squares fmul, char-pointer byte access | 1.36 G | 23 min |
| fmul working vars as globals | 1.157 G | 19.6 min |
| dx^2 by second differences: hit test = one compare | **1.121 G** (measured) | **19.0 min** |

cc64-generated code averages ~2.85 cycles/instruction; the first rows are
rescaled from instruction counts, the last two are cycle-exact
(`make bench PRG=...`). The second-difference step also measured fmul's
real cost: ~1700 cycles/call — the remaining hot spot is the ~10 fmul
calls per sphere-hit pixel (trace_sphere + sample_ray), ~65% of the frame.

Further candidates: fewer fmuls per hit (algebraic rework of the
reflection), a squares-only fsq() (3 lookups instead of 4 products),
incremental shadow-ray terms (linear in hx), fdiv/isqrt internals as
globals.

## cc64 dialect traps found while porting (the hard way)

- **`>>` is an arithmetic shift** (sign-extending), via the runtime's
  `$shr`. `fmul`'s unsigned-low-byte term needs `& 255` after shifting.
- **`/` and `%` floor toward minus infinity** (`-9/2 == -5`, `-9%2 == 1`).
- **Small `#define`s are char-typed** (preprocessor types by value:
  high byte set → int, else char). A char-typed constant assigned to an
  int, passed as an argument, or returned is materialized size-1 — the
  high byte keeps stale register contents (often `$ff` right after a
  true comparison). Fixes: keep shade-sized values in `char` variables
  (char *loads* clear the high byte), or force int-ness with `0 + NAME`
  at argument sites. Character literals (`'a'`) are int-typed and safe.
- **Locals cost ~2x globals**: locals are (frame),y indirection, globals
  are absolute addressing. Hot leaf functions want file-scope globals.
- **The locals stack starts right after the loaded PRG image** and grows
  up: a big program plus a bitmap at $4000 collide silently. Hence the
  bitmap at $e000 under the ROM (writes land in RAM; never read it back).
