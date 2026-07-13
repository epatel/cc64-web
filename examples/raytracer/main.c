/* main.c - entry, video init, render loop with 4x4 Bayer dithering.
 * C port of inspiration-raytracer (mirror sphere over a checkered floor),
 * dithered to 320x200 hires mono. VIC bank 1: bitmap $4000, screen $6000.
 */

#include "rt-c64-08-9f.h"
#include "scene.h"
#include "protos.h"

char bayer[16] = { 0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5 };
char bmask[8] = { 128, 64, 32, 16, 8, 4, 2, 1 };

int init_video()
{
  char *v;
  char *p;
  int i;
  v = 0xdd00;                    /* VIC bank 1 ($4000-$7fff) */
  *v = (*v & 0xfc) | 2;
  v = 0xd018;                    /* screen at $6000, bitmap at $4000 */
  *v = 0x80;                     /* hi nibble 8 = screen +$2000; bit3 0 = bitmap +$0000 */
  v = 0xd011;                    /* hires bitmap mode on */
  *v = 0x3b;
  v = 0xd016;
  *v = 0xc8;
  v = 0xd020;
  *v = 0;
  v = 0xd021;
  *v = 0;
  p = 0x4000;                    /* clear bitmap */
  for (i = 0; i < 8000; ++i)
    *p++ = 0;
  p = 0x6000;                    /* white on black */
  for (i = 0; i < 1000; ++i)
    *p++ = 0x10;
}

main()
{
  int x, y, rowbase, brow;
  char sh;
  char *p;
  init_video();
  for (y = 0; y < 200; ++y) {
    rowbase = 0x4000 + ((y >> 3) * 320) + (y & 7);
    brow = (y & 3) << 2;
    for (x = 0; x < 320; ++x) {
      sh = trace_pixel(x, y);
      if (sh > bayer[brow + (x & 3)]) {
        p = rowbase + ((x >> 3) << 3);
        *p = *p | bmask[x & 7];
      }
    }
  }
  for (;;)
    ;
}
