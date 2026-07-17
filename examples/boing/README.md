# boing — a bouncing red/white ball (cc64 C)

A small homage to the Amiga Boing demo: a red/white checkered ball
bouncing around the screen with gravity, spinning in the direction of
travel. Its purpose is to show off cc64-web's **`__sprite` extension** —
the ball is three multicolor sprite definitions drawn as pixel art
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
would give a hires sprite instead. The three frames are the same ball
with the checker pattern shifted one column — cycling the sprite pointer
through them makes it spin, forward or backward with the sign of the
horizontal velocity.

The rest is a plain VIC single-sprite demo: the 64-byte arrays are copied
to $2000/$2040/$2080 (sprite data must sit on 64-byte boundaries in the
VIC bank — the arrays themselves are ordinary statics, so they aren't
aligned), movement is 1/8-pixel fixed point with constant-energy bounces
and gravity, one update per frame off a $d012 raster compare, and the
9th sprite-x bit comes from `spr_xmsb = px > 255`.

## Build

```bash
node examples/boing/mkproject.mjs
```

compile-checks with the compiler, writes `boing.prg`, and joins the source
into `boing.cc64proj.json` — import that in the cc64-web page (⤒ button in
the project bar), or create a fresh file from the IDE's "Sprite demo"
template for the single-sprite starter version.
