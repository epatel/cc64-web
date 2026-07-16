# raytracer — mirror sphere over a checkered floor (cc64 C)

A C port of the assembly raytracer (`inspiration-raytracer/`): one shiny
sphere (mirror + Lambertian) over an infinite checkerboard, directional
light with cast shadows, sky darkening toward the horizon, blue-noise
dithered to 320x200 hires mono. Written in cc64's small-C dialect; all math is
signed 8.8 fixed point in 16-bit ints (`fixmath.c` — no float, no longs).

## Files

- `main.c` — video init (VIC bank 3: bitmap $e000 under the KERNAL ROM —
  the render path is write-only — screen $c400), row-based render loop,
  16x16 blue-noise dither (the asm original's table)
- `trace.c` — `trace_sphere`/`sample_ray`: half-b sphere quadratic,
  one-bounce mirror reflection (normal-free algebra, see the header),
  N·L diffuse, floor shadow ray, sky gradient
- `scene.h` — scene constants (8.8), with hand-derived `SPH_C2R`,
  `OCY_LY`, `CC_SH`, `C_DOT_L` (formulas in the header)
- `fixmath.c` — `fmul`/`fsq`/`fdiv`/`fsqrt`/`isqrt` under cc64 semantics;
  operands go directly into the zeropage cells, no parameters
- `protos.h` — prototypes (the unity build is alphabetical, so cross-file
  calls need cc64's jmp-stub prototypes — measured at 0.022% of the
  frame, see the end of the performance log)

## Build

```bash
node examples/raytracer/mkproject.mjs
```

compile-checks with the real compiler, writes `raytracer.prg`, and joins
the sources into `raytracer.cc64proj.json` — import that in the cc64-web
page (⤒ button in the project bar) to get the whole thing as an editable
multi-file project.

Verified end-to-end in the browser (at the 5.1-minute version): the
imported project compiled in the IDE to the same bytes as the node build
(`__asm` and all), and the PRG ran in Web64 to a complete correct frame
in ~5 real minutes — matching the harness prediction. The current build
is 17161 bytes, 3.9 minutes on the harness. Note web64's `?warp=true`
only warps boot+load; the render itself runs at 1x.

Originally verified pixel-identical against a JS model of the algorithm by
executing the compiled PRG on `tools/run6502.mjs`. The later
reflection-algebra rework takes different fixed-point rounding paths and
flips 212 of 64,000 pixels (0.33%, scattered dither-level changes on the
sphere and its reflection); the incremental shadow term moves the cast
shadow's dithered edge by another 34 pixels (0.05%).

## Performance log (`node tools/bench6502.mjs raytracer.prg`)

| version | cycles/frame | C64 time at 1x (PAL) |
|---|---|---|
| naive per-pixel trace | ~7.5 G (est.) | ~2h 7m |
| row constants, sphere x-band, byte plotting | 1.67 G | 28 min |
| table-of-squares fmul, char-pointer byte access | 1.36 G | 23 min |
| fmul working vars as globals | 1.157 G | 19.6 min |
| dx^2 by second differences: hit test = one compare | 1.121 G | 19.0 min |
| fmul working vars `__zeropage` (cc64-web extension) | 1.083 G | 18.3 min |
| fdiv/isqrt reuse fmul's zp cells (all leaves) | 1.003 G | 17.0 min |
| render state to globals; hottest 5 in zp (pool full) | 0.978 G | 16.5 min |
| `__asm` quarter-square fmul (self-modifying, as the original) | 0.411 G | 7.0 min |
| `__asm` fdiv (24-step long division) + isqrt (inline shifts) | 0.301 G | 5.1 min |
| fixmath operands straight into the zp cells (no parameters) | 0.273 G | 4.6 min |
| reflection algebra: g = t*a - b, R = k*D + 2g*C — N never built | 0.251 G | 4.3 min |
| unrolled: fdiv steps x8, floor byte loop x8, init_video clears x8 | 0.244 G | 4.1 min |
| fsq(): squares-only quarter-square (P1 = P2, f(0) rows collapse) | 0.236 G | 4.0 min |
| fdiv leading-zero skip: numerator < 1.0 jumps a whole 8-step pass | 0.229 G | 3.9 min |
| incremental shadow term: sb = hx*lx + khz tracked 8.16 like hx | **0.225 G** (measured) | **3.8 min** |

**The asm original measures 387 M cycles = 6.6 min at 1x** on the same
harness (full frame verified) — this version now **beats it by 42%**:
same fixed-point kernels (fmul/umul16 ported near-verbatim into cc64-web
`__asm` blocks — operand bytes patched into the lookup instructions,
the |a-b| index by the complement trick, byte tables at $c800-$cfff
behind the bank-3 screen; fdiv's 24-step shift-subtract long division;
isqrt with inline lsr/ror), while the C row/band structure does per-row
constant folding the original left as a TODO. fmul: 2,185 -> 270
cyc/call; fdiv: 2,819 -> 1,345; isqrt: 1,657 -> 599. The `__zeropage`
round before it exhausted the $57..$70 pool: fmul's cells double as
fdiv/isqrt scratch (leaf functions, never live at once), fsqrt's Newton
temp survives its fdiv call so it owns a cell, and main's per-pixel
accumulators (x, hxhi, hxlo, vh, vl, sh, bits) fill the rest.
The zp-operands row drops cc64's parameter passing for the fixmath leaves
entirely: callers store the operands into m_a/m_b themselves and the
functions take no arguments (~82 cycles saved per 2-arg call — stack
push, (frame),y reload and zp store all gone; cc64 has no function-like
macros, so the call sites sequence the stores explicitly).
The reflection row reworks the hit path algebraically (trace.c header):
with a = D.D and b = D.C already in hand, D.N = t*a - b, N.L =
t*(D.L) - C.L (C.L is the compile-time C_DOT_L, D.L's dy part is
per-row) and R = k*D + 2(D.N)*C with k = 1 - 2(D.N)t (the C terms are
shifts) — 6-8 fmuls per hit instead of 10, and sky-bound reflections
skip P = t*D and the sample_ray call entirely (16,658 -> 8,143 calls).
The unroll row is mechanical: fdiv's 24 division steps as 3 passes of 8,
the plain-floor pixel loop as 8 copies (letting the bnoise index and the
x advance hoist out), init_video's clears x8 — +6 KB of PRG for -7.6 M
cycles.
The fsq row adds a squares-only quarter-square routine (fixmath.c):
x^2 >= 0 kills the sign logic, the cross partials coincide (P1 = P2,
computed once, added twice), and AL*AL = f(AL+AL) - f(0) with f(0) = 0
turns P0/P3 into single direct table reads — 161 vs 266 cyc/call over
65,915 self-multiplies (the shadow tests' sb^2/hxhi^2 dominate),
bit-exact with fmul(x, x) so the render is unchanged.
The fdiv skip: when |a| < 1.0 the dividend register's first 8 steps
only shift zeros (no remainder, no quotient bits), so [0, al, 0]
pre-shifts to [al, 0, 0] and one whole unrolled pass is skipped —
about half the frame's 41,882 divisions qualify (sample_ray's
FLOOR_Y - oy on the lower sphere half, fsqrt's Newton divide near the
band edges); fdiv 1,250 -> 1,095 cyc/call, 5 cycles for the rest.
The shadow-term row notices sb is linear in hx: an 8.16 accumulator
(seeded per row, stepped by fmul(2*t2, lx) split into hi/lo bytes)
replaces ~24,600 per-pixel fmuls with two adds each. The accumulator
sees the exact 8.16 hx where the fmul saw the truncated 8.8 one, so the
shadow's dithered edge shifts by 34 pixels.
Incidentally 6.6 min at 1x vs the author's "~2:20 under warp" implies a
~2.8x warp — matching web64's observed warp factor.

cc64-generated code averages ~2.85 cycles/instruction; the first rows are
rescaled from instruction counts, the later ones are cycle-exact
(`make bench PRG=...`). Where the time goes now
(`make profile SRC=examples/raytracer`):

```
main        52.3M  23.3%
fdiv        45.9M  20.4%    41,882 calls  1,095 cyc/call
fmul        42.7M  19.0%   162,522 calls    262 cyc/call
trace_sphere 26.6M  11.9%   16,658 calls  1,599 cyc/call
fsq         10.6M   4.7%    65,915 calls    161 cyc/call
sample_ray  10.3M   4.6%     8,143 calls  1,268 cyc/call
```

What's left is compiled-C glue: trace_sphere/sample_ray's 1,599/1,268
cyc/call are mostly their own argument passing and 16-bit temp shuffling
around 6-8 fmul calls per sphere pixel. Remaining candidate: passing
trace_sphere/sample_ray arguments through globals the way fixmath does.

Rejected: patching prototype call sites directly instead of cc64's
3-byte jmp stubs (calls emitted *before* a function's definition go
jsr stub -> jmp real; calls after it already go direct). Measured on
the full frame: the build has 9 stubs (27 bytes) and only one is ever
hot — main.c's calls to trace_sphere (main.c sorts before trace.c in
the alphabetical unity build) — 16,658 executions x 3 cycles = ~50k
cycles, 0.022% of the run. Removing the stubs would also shift every
subsequent code address, breaking byte-identity with real cc64 (the
prime directive), and address-of a prototyped function (function
pointers, static initializers) resolves to the stub too, so every such
site would need its own patch record. If those 50k cycles ever matter,
the zero-divergence fix is ordering trace.c before main.c in the
amalgamation so the hot call follows its definition.

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
  are absolute addressing. Hot leaf functions want file-scope globals —
  or `__zeropage` globals (cc64-web extension, $57..$70 pool), which shave
  another cycle per access. Note the extension does not compile on real
  cc64.
- **The locals stack starts right after the loaded PRG image** and grows
  up: a big program plus a bitmap at $4000 collide silently. Hence the
  bitmap at $e000 under the ROM (writes land in RAM; never read it back).
