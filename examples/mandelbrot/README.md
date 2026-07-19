# mandelbrot — 8.8 fixed-point Mandelbrot, multicolor bitmap

Port of the web64 "C Fixed Mandelbrot Bitmap" example to cc64, replacing
`web64/fixed.h` with the raytracer's quarter-square 8.8 fixed point
(`fixmath.c`, trimmed to `init_tables`/`fmul`/`fsq` — no divide/sqrt).

## What it shows

- **Raytracer fixmath reuse**: operands go straight into the zero-page
  cells `m_a`/`m_b` and the multiply is a parameterless call —
  `m_a = zr; rsq = fsq();` — skipping cc64's ~82-cycle parameter passing.
  `fsq()` (the squared-operand reduction of `fmul`) covers two of the
  three multiplies per iteration.
- **Multicolor bitmap mode**, VIC bank 3 like the raytracer: bitmap $e000
  (RAM under the KERNAL — the renderer only writes), screen $c400,
  quarter-square tables $c800–$cfff. 160×200 pixels, one Mandelbrot
  sample per pixel pair.
- **`__zeropage` budget**: fixmath's six cells plus the six per-pixel
  hot variables (`zr zi cre cim rsq isq`) fill the $57..$70 pool.

## Coordinates & colors

8.8 fixed point, 256 = 1.0. Window: real −550..+250 (−2.15..0.98) at
5/pixel, imag +307..−293 (1.20..−1.14) at 3/line. Escape when
|z|² > 4.0 (1024), 24 iterations max. Escape-count bands map to
%01 red / %10 orange / %11 yellow (same banding as the web64 original);
the set interior is background black.

Self-checking: six oracle points (interior must reach 24 iterations,
exterior must escape) run before video init — red border + text screen
means the fixed-point math is broken. Border cycles with the cell row as
a progress bar; green border = done. Full render ≈ 357 M cycles ≈ 6
minutes of C64 time (use warp).

## Build

```
node examples/mandelbrot/mkproject.mjs
```

compile-checks with the real compiler and writes `mandelbrot.prg` +
`mandelbrot.cc64proj.json` (importable via the ⤒ button in the web UI).
