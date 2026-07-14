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

/* Render state at file scope: cc64 compiles globals to absolute addressing,
 * locals to (frame),y indirection at about twice the cost - and this loop
 * runs 64000 times. The per-pixel hottest go in the zero page (cc64-web
 * '__zeropage' extension), filling the $57..$70 pool to the last byte. */
__zeropage int x, hxhi, hxlo, vh, vl;
__zeropage char sh, bits;
int y, dy, i;
int t2, dhi, dlo, z256, hzc, khz, kcc;
int brow, arow, b2, lim, x0, x1, xa, xb, a, disc, sb, rowbase;
int d1h, d1l, dxa;
char rsh, hazerow, shadrow, sky, bny, pb0, pb1;
char *p;

main()
{
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
      m_a = 0 + FLOOR_Y;
      m_b = dy;
      t2 = fdiv();
      if (t2 < 0) hazerow = 1;
      if (t2 >= 0x2000) hazerow = 1;
      if (hazerow) rsh = SHD_HAZE;
      z256 = t2 & 256;                   /* hz = t2 (vz = 1.0): checker z-parity */
      hzc = t2 - SPH_CZ;
      if (hzc < SHADOW_RAW && hzc > -SHADOW_RAW) shadrow = 1;
      m_a = hzc;
      m_b = 0 + LGT_Z;
      khz = OCY_LY + fmul();
      m_a = hzc;
      m_b = hzc;
      kcc = CC_SH + fmul();
      m_a = t2;
      m_b = -320;
      hxhi = fmul();                     /* hx at x=0 (dx = -320) */
      hxlo = 0;
      dlo = (t2 << 1) & 255;             /* exact 8.16 step: t2*2 */
      dhi = (t2 << 1) >> 8;
    }

    /* ---- per-row sphere band: disc >= 0 iff dx^2 <= b2/c - dy^2 - 1 ---- */
    m_a = dy;
    m_b = 0 + SPH_CY;
    brow = fmul() + SPH_CZ;
    m_a = dy;
    m_b = dy;
    arow = fmul() + 256;
    m_a = brow;
    m_b = brow;
    b2 = fmul();
    x0 = 320;
    x1 = -1;
    xa = 320;
    xb = -1;
    m_a = b2;
    m_b = 0 + SPH_C2R;
    lim = fdiv() - arow;
    if (lim > 0) {
      m_a = lim;
      x1 = fsqrt() >> 1;                 /* dx = (x-160)*2: half in pixels */
      x0 = 160 - x1 - 2;
      x1 = 160 + x1 + 2;
      xa = x0 & 0xf8;                    /* byte-aligned band */
      xb = x1 | 7;
      if (xa < 0) xa = 0;
      if (xb > 319) xb = 319;
      /* dx^2 tracked by exact second differences (24-bit as vh.vl):
       * V(x) = dx^2, dV = 4*dx + 4, ddV = 8. Hit iff vh <= lim. */
      dxa = (xa - 160) << 1;
      if (dxa < 0) vh = -dxa; else vh = dxa;
      vl = ((vh & 255) * (vh & 255)) & 255;
      m_a = vh;
      m_b = vh;
      vh = fmul();
      d1l = ((dxa << 2) + 4) & 255;
      d1h = ((dxa << 2) + 4) >> 8;
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
          sh = 255;
          if (vh <= lim) {
            a = vh + arow;
            m_a = a;
            m_b = 0 + SPH_C2R;
            disc = b2 - fmul();
            if (disc >= 0)
              sh = trace_sphere((x - 160) << 1, dy, a, brow, disc);
          }
          if (sh == 255) sh = rsh;
          bits = bits + bits;
          if (sh > bnoise[bny + (x & 15)]) bits = bits + 1;
          if ((x & 7) == 7) {
            *p = bits;
            p = p + 8;
            bits = 0;
          }
          vl = vl + d1l;
          if (vl > 255) { vl = vl - 256; vh = vh + 1; }
          vh = vh + d1h;
          d1l = d1l + 8;
          if (d1l > 255) { d1l = d1l - 256; d1h = d1h + 1; }
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
            sh = 255;
            if (vh <= lim) {
              a = vh + arow;
              m_a = a;
              m_b = 0 + SPH_C2R;
              disc = b2 - fmul();
              if (disc >= 0)
                sh = trace_sphere((x - 160) << 1, dy, a, brow, disc);
            }
            if (sh == 255) {
              if ((hxhi & 256) != z256) sh = SHD_CHK_HI; else sh = SHD_CHK_LO;
              if (shadrow) {
                if (hxhi < SHADOW_RAW && hxhi > -SHADOW_RAW) {
                  m_a = hxhi;
                  m_b = 0 + LGT_X;
                  sb = fmul() + khz;
                  if (sb < 0) {
                    m_a = sb;
                    m_b = sb;
                    sb = fmul();       /* sb reused: now sb^2 */
                    m_a = hxhi;
                    m_b = hxhi;
                    if (sb - (fmul() + kcc) > 0)
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
            vl = vl + d1l;
            if (vl > 255) { vl = vl - 256; vh = vh + 1; }
            vh = vh + d1h;
            d1l = d1l + 8;
            if (d1l > 255) { d1l = d1l - 256; d1h = d1h + 1; }
            ++x;
          }
        } else {
          /* plain floor: one byte = 8 pixels */
          for (i = 8; i; --i) {
            if ((hxhi & 256) != z256) sh = SHD_CHK_HI; else sh = SHD_CHK_LO;
            if (shadrow) {
              if (hxhi < SHADOW_RAW && hxhi > -SHADOW_RAW) {
                m_a = hxhi;
                m_b = 0 + LGT_X;
                sb = fmul() + khz;
                if (sb < 0) {
                  m_a = sb;
                  m_b = sb;
                  sb = fmul();         /* sb reused: now sb^2 */
                  m_a = hxhi;
                  m_b = hxhi;
                  if (sb - (fmul() + kcc) > 0)
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
