# boing — a bouncing red/white ball (cc64 C)

A small homage to the Amiga Boing demo: a red/white checkered ball
bouncing around the screen with gravity, rolling over its own checker
pattern. Its purpose is to show off cc64-web's **`__sprite` extension** —
the ball is six multicolor sprite definitions drawn as pixel art
directly in the C source:

```c
__sprite ball0 = {
  .... oo-- ....
  ...o oo-- -...
  ...
};
```

Each row is 12 pairs (`.` transparent, `-` = shared multicolor $d025 =
white, `o` = the sprite's own color $d027 = red); 24-char rows of `.`/`x`
would give a hires sprite instead. The six frames are the same ball with
the checker pattern shifted one column each — the full period, since the
checkers repeat every 6 columns (3 red + 3 white; with only half the
phases the pattern color-flips every 6 px). The sprite pointer is picked
straight from the x position (`(px/2) % 6`), which locks the checkers to
the screen — the ball rolls over a fixed pattern, drift-free at any speed
in either direction.

The rest is a plain VIC single-sprite demo: the 64-byte arrays are copied
to $2000..$2140, blocks 128..133 (sprite data must sit on 64-byte
boundaries in the VIC bank — the arrays themselves are ordinary statics,
so they aren't aligned), movement is 1/8-pixel fixed point with
constant-energy bounces and gravity, one update per frame off a $d012
raster compare, and the 9th sprite-x bit comes from
`spr_xmsb = px > 255`.

## Lessons learned (the hard way)

- **Byte-sized `#define`s are CHAR-typed** and assign with a junk high
  byte: `x = XMIN` (192) corrupted x at the left wall and froze the ball
  mid-screen. Use `0 + XMIN` (the raytracer README documents the trap).
- **Spin frames must cover the pattern's full period.** The checkers
  repeat every 6 columns; with only 3 phases the modulo wraps half-way
  and the pattern color-flips every 6 px of travel — perceived as a
  violent shimmer. Frame count = period / shift-per-frame, no shortcuts.
- **Pick the frame from the position, not a counter.** `(px/2) % 6`
  cannot drift out of phase; an incremented counter can (and did, around
  wall bounces).
- **Emulator frame pacing adds judder you can't fix in the PRG.**
  Sampling web64's rendered canvas showed displayed velocity fluctuating
  0.3x–1.9x at a nominally constant 2 px/frame (frames delivered 8–40 ms
  apart on a 120 Hz display). Judder amplitude scales with speed, hence
  the slow Amiga drift (1 px/frame); the same PRG is smooth on real
  hardware.

## Build

```bash
node examples/boing/mkproject.mjs
```

compile-checks with the compiler, writes `boing.prg`, and joins the source
into `boing.cc64proj.json` — import that in the cc64-web page (⤒ button in
the project bar), or create a fresh file from the IDE's "Sprite demo"
template for the single-sprite starter version.
