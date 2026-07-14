/* main.c - entry, video init, row-based render loop, blue-noise dither.
 * C port of inspiration-raytracer (mirror sphere over a checkered floor),
 * dithered to 320x200 hires mono. VIC bank 3: bitmap $e000 (RAM under the
 * KERNAL ROM - the render path is write-only), screen $c400, squares table
 * at $c000. All of $0801-$9fff stays free for code + locals stack.
 *
 * Speed structure (the asm version's "per-scanline constant folding" TODO,
 * taken further):
 * - sky/haze rows: shade is constant -> the 16px-periodic dither pattern is
 *   built once (2 bytes) and the row is a 40-byte fill
 * - floor rows: t2, hz, checker z-parity and shadow constants are per-row;
 *   hx advances by an exact 8.16 increment; checker parity is one AND
 *   (no shifts); the pixel loop runs in whole bytes
 * - the sphere exists only where dx^2 <= b^2/c - dy^2 - 1 (solved per row),
 *   so the full quadratic + reflection runs only inside that x band
 */

#include "rt-c64-08-9f.h"
#include "scene.h"
#include "protos.h"

/* 16x16 blue noise (void-and-cluster), from inspiration-raytracer;
 * plot a pixel when shade > bnoise[(y&15)*16 + (x&15)] */
char bnoise[256] = {
   8,  0, 15,  4,  2, 11,  0,  5, 11,  9, 10,  3, 12, 13,  4,  6,
  12,  3,  7, 10,  8, 13,  4, 15,  3, 13,  1,  5,  7,  2, 10, 15,
   2,  9, 14,  1,  6,  2,  9,  8,  1,  6, 12, 15, 11,  8,  4, 11,
   7,  4, 12,  3, 15, 12,  7, 11, 14,  4,  8,  0,  3, 14,  1,  5,
  15,  0, 10,  7,  9,  3,  0,  5,  2, 11,  9,  5,  7, 13,  9, 12,
   8,  6, 14,  1,  5, 14, 10, 13,  6, 15,  1, 14, 11,  6,  4,  1,
  10,  3,  2, 12,  6, 11,  4,  8,  0,  7, 12,  3,  0,  9,  2, 14,
   5, 13,  9, 15,  0,  8,  2, 15, 10,  2,  5,  8, 10, 15, 12,  7,
  11,  1,  7,  4, 10, 13,  6, 12,  4, 13, 11, 14,  1,  6,  3,  0,
  15,  6, 13,  2,  5,  3,  9,  1,  6,  8,  0,  4,  5, 10, 13,  9,
   2,  3,  9, 14, 11,  8, 14,  4, 14,  2,  9, 15, 12,  2,  7,  5,
  10, 13,  8,  0,  7,  1, 11,  7, 11, 13,  3,  6,  8,  0, 14, 12,
   0,  5,  3, 12,  4, 13,  2,  5,  0,  5, 10,  1, 13, 10,  4,  6,
  14, 11,  7, 15, 10,  6, 15,  9, 13,  8, 15,  4, 12,  5,  2,  8,
   3,  5,  1,  9,  1,  3, 10,  1,  4, 11,  0,  7,  3, 11, 15, 10,
  13,  9, 12,  6, 14,  8, 12,  7, 14,  2,  6, 14,  9,  0,  7,  1
};

int init_video()
{
  char *v;
  char *p;
  int i;
  v = 0xdd00;                    /* VIC bank 3 ($c000-$ffff) */
  *v = *v & 0xfc;
  v = 0xd018;                    /* screen at $c400, bitmap at $e000 */
  *v = 0x18;
  v = 0xd011;                    /* hires bitmap mode on */
  *v = 0x3b;
  v = 0xd016;
  *v = 0xc8;
  v = 0xd020;
  *v = 0;
  v = 0xd021;
  *v = 0;
  p = 0xe000;                    /* clear bitmap (RAM under the KERNAL ROM:
                                    the renderer only ever writes) */
  for (i = 0; i < 8000; ++i)
    *p++ = 0;
  p = 0xc400;                    /* white on black */
  for (i = 0; i < 1000; ++i)
    *p++ = 0x10;
}

main()
{
  int y, x, dy, dx, i;
  int t2, hxhi, hxlo, dhi, dlo, z256, hzc, khz, kcc;
  int brow, arow, b2, lim, x0, x1, xa, xb, a, disc, sb, rowbase;
  char sh, rsh, hazerow, shadrow, sky, bits, bny, pb0, pb1;
  char *p;

  init_tables();
  init_video();
  for (y = 0; y < 200; ++y) {
    dy = (100 - y) << 1;
    rowbase = 0xe000 + ((y >> 3) * 320) + (y & 7);
    bny = (y & 15) << 4;

    /* ---- per-row constants ---- */
    sky = 0;
    hazerow = 0;
    shadrow = 0;
    if (dy >= 0) {
      sky = 1;
      rsh = 1 + (dy >> 4);
      if (rsh > SKY_MAX) rsh = SKY_MAX;
    } else {
      t2 = fdiv(0 + FLOOR_Y, dy);
      if (t2 < 0) hazerow = 1;
      if (t2 >= 0x2000) hazerow = 1;
      if (hazerow) rsh = SHD_HAZE;
      z256 = t2 & 256;                   /* hz = t2 (vz = 1.0): checker z-parity */
      hzc = t2 - SPH_CZ;
      if (hzc < SHADOW_RAW && hzc > -SHADOW_RAW) shadrow = 1;
      khz = OCY_LY + fmul(hzc, 0 + LGT_Z);
      kcc = CC_SH + fmul(hzc, hzc);
      hxhi = fmul(t2, -320);             /* hx at x=0 (dx = -320) */
      hxlo = 0;
      dlo = (t2 << 1) & 255;             /* exact 8.16 step: t2*2 */
      dhi = (t2 << 1) >> 8;
    }

    /* ---- per-row sphere band: disc >= 0 iff dx^2 <= b2/c - dy^2 - 1 ---- */
    brow = fmul(dy, 0 + SPH_CY) + SPH_CZ;
    arow = fmul(dy, dy) + 256;
    b2 = fmul(brow, brow);
    x0 = 320;
    x1 = -1;
    xa = 320;
    xb = -1;
    lim = fdiv(b2, 0 + SPH_C2R) - arow;
    if (lim > 0) {
      x1 = fsqrt(lim) >> 1;              /* dx = (x-160)*2: half in pixels */
      x0 = 160 - x1 - 2;
      x1 = 160 + x1 + 2;
      xa = x0 & 0xf8;                    /* byte-aligned band */
      xb = x1 | 7;
      if (xa < 0) xa = 0;
      if (xb > 319) xb = 319;
    }

    if (sky || hazerow) {
      /* ---- constant-shade row: 2 pattern bytes + 40-byte fill ---- */
      pb0 = 0;
      pb1 = 0;
      for (i = 0; i < 8; ++i) {
        pb0 = pb0 + pb0;
        if (rsh > bnoise[bny + i]) pb0 = pb0 + 1;
        pb1 = pb1 + pb1;
        if (rsh > bnoise[bny + 8 + i]) pb1 = pb1 + 1;
      }
      p = rowbase;
      for (i = 0; i < 20; ++i) {
        *p = pb0;
        p = p + 8;
        *p = pb1;
        p = p + 8;
      }
      if (xb >= 0) {
        /* redo the sphere band per-pixel over the fill */
        p = rowbase + xa;
        bits = 0;
        for (x = xa; x <= xb; ++x) {
          dx = (x - 160) << 1;
          sh = 255;
          if (x >= x0 && x <= x1) {
            a = fmul(dx, dx) + arow;
            disc = b2 - fmul(a, 0 + SPH_C2R);
            if (disc >= 0)
              sh = trace_sphere(dx, dy, a, brow, disc);
          }
          if (sh == 255) sh = rsh;
          bits = bits + bits;
          if (sh > bnoise[bny + (x & 15)]) bits = bits + 1;
          if ((x & 7) == 7) {
            *p = bits;
            p = p + 8;
            bits = 0;
          }
        }
      }
    } else {
      /* ---- floor row: whole-byte loop, per-pixel work minimal ---- */
      p = rowbase;
      bits = 0;
      x = 0;
      while (x < 320) {
        if (x == xa) {
          /* mixed segment [xa..xb]: sphere band over the floor */
          while (x <= xb) {
            dx = (x - 160) << 1;
            sh = 255;
            if (x >= x0 && x <= x1) {
              a = fmul(dx, dx) + arow;
              disc = b2 - fmul(a, 0 + SPH_C2R);
              if (disc >= 0)
                sh = trace_sphere(dx, dy, a, brow, disc);
            }
            if (sh == 255) {
              if ((hxhi & 256) != z256) sh = SHD_CHK_HI; else sh = SHD_CHK_LO;
              if (shadrow) {
                if (hxhi < SHADOW_RAW && hxhi > -SHADOW_RAW) {
                  sb = fmul(hxhi, 0 + LGT_X) + khz;
                  if (sb < 0) {
                    if (fmul(sb, sb) - (fmul(hxhi, hxhi) + kcc) > 0)
                      sh = sh >> 2;
                  }
                }
              }
            }
            bits = bits + bits;
            if (sh > bnoise[bny + (x & 15)]) bits = bits + 1;
            if ((x & 7) == 7) {
              *p = bits;
              p = p + 8;
              bits = 0;
            }
            hxlo = hxlo + dlo;
            if (hxlo > 255) { hxlo = hxlo - 256; hxhi = hxhi + 1; }
            hxhi = hxhi + dhi;
            ++x;
          }
        } else {
          /* plain floor: one byte = 8 pixels */
          for (i = 8; i; --i) {
            if ((hxhi & 256) != z256) sh = SHD_CHK_HI; else sh = SHD_CHK_LO;
            if (shadrow) {
              if (hxhi < SHADOW_RAW && hxhi > -SHADOW_RAW) {
                sb = fmul(hxhi, 0 + LGT_X) + khz;
                if (sb < 0) {
                  if (fmul(sb, sb) - (fmul(hxhi, hxhi) + kcc) > 0)
                    sh = sh >> 2;
                }
              }
            }
            bits = bits + bits;
            if (sh > bnoise[bny + (x & 15)]) bits = bits + 1;
            hxlo = hxlo + dlo;
            if (hxlo > 255) { hxlo = hxlo - 256; hxhi = hxhi + 1; }
            hxhi = hxhi + dhi;
            ++x;
          }
          *p = bits;
          p = p + 8;
          bits = 0;
        }
      }
    }
  }
  for (;;)
    ;
}
