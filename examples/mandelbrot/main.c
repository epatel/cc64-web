/* main.c - 8.8 fixed-point Mandelbrot in C64 multicolor bitmap mode.
 *
 * Port of the web64 "C Fixed Mandelbrot Bitmap" example to cc64, using
 * the raytracer's quarter-square 8.8 fixed point (fixmath.c: fmul/fsq
 * with operands passed through zero-page globals m_a/m_b) instead of
 * web64/fixed.h.
 *
 * VIC bank 3 like the raytracer: bitmap $e000 (RAM under the KERNAL ROM
 * - the render path is write-only), screen $c400, quarter-square tables
 * $c800-$cfff. 160x200 multicolor pixels, one mandel sample per pixel
 * pair; escape-count bands map to %01/%10/%11, set interior to %00
 * (background black). Border cycles with the cell row as a progress bar,
 * green when done.
 *
 * Coordinates (8.8, 256 = 1.0): real -550..+250 step 5/pixel,
 * imag +307..-293 step 3/line - the classic -2.15..0.98 x -1.14..1.20
 * window. Escape when |z|^2 > 4.0 (1024), 24 iterations max.
 */

#include "rt-c64-08-9f.h"

/* fixmath.c owns m_a..m_s (12 zp bytes); the per-pixel hot state fills
 * the rest of the $57..$70 pool (cc64-web '__zeropage' extension). */
__zeropage int zr, zi, cre, cim, rsq, isq;

/* Render state at file scope: cc64 compiles globals to absolute
 * addressing, locals to (frame),y indirection at about twice the cost. */
int tri;                        /* zr*zi cross term */
int n, pp;                      /* iteration count, 2-bit pixel pair */
int crow, col, py, pair;        /* loop counters */
int rowbase, cellad;            /* bitmap addresses */
int cre0, rowim;                /* top-left c of the current cell */
int fails;
char b;                         /* multicolor byte under construction */
char *bp;
char *v;

/* z -> z^2 + c for c = (cre, cim); returns iterations to escape, or 24
 * if still bounded. fsq/fmul clobber m_a/m_b/m_r/m_t/m_u/m_s only. */
int mandel_iter()
{
  zr = 0;
  zi = 0;
  n = 0;
  while (n < 24) {
    m_a = zr;
    rsq = fsq();
    m_a = zi;
    isq = fsq();
    if (rsq + isq > 1024) return n;
    m_a = zr;
    m_b = zi;
    tri = fmul();
    zr = rsq - isq + cre;
    zi = tri + tri + cim;
    n = n + 1;
  }
  return 24;
}

/* Self-check on known points before touching the screen (still on the
 * default text screen if it fails): interior points must reach 24
 * iterations, exterior points must escape. */
int run_oracles()
{
  fails = 0;
  cre = 0;    cim = 0;   if (mandel_iter() != 24) ++fails;  /* 0 */
  cre = -256; cim = 0;   if (mandel_iter() != 24) ++fails;  /* -1 */
  cre = -512; cim = 0;   if (mandel_iter() != 24) ++fails;  /* -2 */
  cre = -32;  cim = 192; if (mandel_iter() != 24) ++fails;  /* -.125+.75i */
  cre = 256;  cim = 0;   if (mandel_iter() == 24) ++fails;  /* 1 */
  cre = 256;  cim = 256; if (mandel_iter() == 24) ++fails;  /* 1+i */
}

int init_video()
{
  char *p;
  int i;
  v = 0xdd00;                    /* VIC bank 3 ($c000-$ffff) */
  *v = *v & 0xfc;
  v = 0xd018;                    /* screen at $c400, bitmap at $e000 */
  *v = 0x18;
  v = 0xd011;                    /* bitmap mode on */
  *v = 0x3b;
  v = 0xd016;                    /* multicolor on */
  *v = 0xd8;
  v = 0xd020;
  *v = 0;
  v = 0xd021;
  *v = 0;
  p = 0xe000;                    /* clear bitmap (RAM under the KERNAL ROM:
                                    the renderer only ever writes) */
  for (i = 0; i < 1000; ++i) {
    *p++ = 0; *p++ = 0; *p++ = 0; *p++ = 0;
    *p++ = 0; *p++ = 0; *p++ = 0; *p++ = 0;
  }
  p = 0xc400;                    /* %01 = red, %10 = orange, whole screen */
  for (i = 0; i < 1000; ++i) *p++ = 0x28;
  p = 0xd800;                    /* %11 = yellow */
  for (i = 0; i < 1000; ++i) *p++ = 7;
}

/* Escape-count -> 2-bit pixel pair: interior black, then symmetric
 * yellow-cored bands (same mapping as the web64 original). */
int pair_of(int it)
{
  if (it == 24) return 0;
  if (it < 3)  return 1;
  if (it < 7)  return 2;
  if (it < 13) return 3;
  if (it < 19) return 2;
  return 1;
}

int render()
{
  rowim = 307;
  rowbase = 0;
  v = 0xd020;
  for (crow = 0; crow < 25; ++crow) {
    cellad = 0xe000 + rowbase;
    cre0 = -550;
    for (col = 0; col < 40; ++col) {
      bp = cellad;
      cim = rowim;
      for (py = 0; py < 8; ++py) {
        cre = cre0;
        b = 0;
        for (pair = 0; pair < 4; ++pair) {
          pp = pair_of(mandel_iter());
          b = (b << 2) | pp;
          cre = cre + 5;
        }
        *bp++ = b;
        cim = cim - 3;
      }
      cellad = cellad + 8;
      cre0 = cre0 + 20;
    }
    rowim = rowim - 24;
    rowbase = rowbase + 320;
    *v = crow & 15;              /* border progress */
  }
}

main()
{
  init_tables();
  run_oracles();
  if (fails != 0) {              /* red border, stay on the text screen */
    v = 0xd020;
    *v = 2;
    while (1) {}
  }
  init_video();
  render();
  *v = 5;                        /* green border: done */
  while (1) {}
}
