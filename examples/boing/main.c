#include "rt-c64-08-9f.h"

/* boing — a red/white checkered ball (hello, Amiga) bouncing around the
 * screen, drawn with cc64-web's __sprite extension.
 *
 * The three sprites are the same ball with the checker pattern rotated by
 * one column — cycling them as the ball moves makes it spin, forward or
 * backward depending on the direction of travel.
 *
 * Multicolor pixels (12 pairs per row): . = transparent,
 * o = 10 = the sprite's own color ($d027, red),
 * - = 01 = shared multicolor 1 ($d025, white).
 */

__sprite ball0 = {
  .... oo-- ....
  ...o oo-- -...
  ..-o oo-- -...
  .--o oo-- -o..
  .--o oo-- -o..
  .oo- --oo o--.
  ooo- --oo o--.
  ooo- --oo o--.
  ooo- --oo o--.
  ooo- --oo o--.
  ---o oo-- -ooo
  ---o oo-- -oo.
  ---o oo-- -oo.
  ---o oo-- -oo.
  ---o oo-- -oo.
  .oo- --oo o--.
  .oo- --oo o-..
  .oo- --oo o-..
  ..o- --oo o...
  ...- --oo o...
  .... oo-- ....
};

__sprite ball1 = {
  .... o--- ....
  ...o o--- o...
  ..oo o--- o...
  .-oo o--- oo..
  .-oo o--- oo..
  .o-- -ooo ---.
  oo-- -ooo ---.
  oo-- -ooo ---.
  oo-- -ooo ---.
  oo-- -ooo ---.
  --oo o--- ooo-
  --oo o--- ooo.
  --oo o--- ooo.
  --oo o--- ooo.
  --oo o--- ooo.
  .o-- -ooo ---.
  .o-- -ooo --..
  .o-- -ooo --..
  ..-- -ooo -...
  ...- -ooo -...
  .... o--- ....
};

__sprite ball2 = {
  .... ---o ....
  ...o ---o o...
  ..oo ---o o...
  .ooo ---o oo..
  .ooo ---o oo..
  .--- ooo- --o.
  o--- ooo- --o.
  o--- ooo- --o.
  o--- ooo- --o.
  o--- ooo- --o.
  -ooo ---o oo--
  -ooo ---o oo-.
  -ooo ---o oo-.
  -ooo ---o oo-.
  -ooo ---o oo-.
  .--- ooo- --o.
  .--- ooo- --..
  .--- ooo- --..
  ..-- ooo- -...
  ...- ooo- -...
  .... ---o ....
};

/* VIC-II */
char border     *= 0xd020;
char background *= 0xd021;
char spr0_x     *= 0xd000;
char spr0_y     *= 0xd001;
char spr_xmsb   *= 0xd010;
char raster     *= 0xd012;
char spr_enable *= 0xd015;
char spr_mc     *= 0xd01c;
char spr_mc1    *= 0xd025;
char spr0_col   *= 0xd027;
char spr0_ptr   *= 0x07f8;   /* sprite pointers sit after the $0400 screen */

extern _fastcall putchar() *= 0xffd2;   /* KERNAL CHROUT */

/* movement in 1/8 pixels; the ball is 24x21, visible x is 24..343.
   XMIN fits in a byte, so cc64 types it CHAR and assigning it directly
   plants a junk high byte — always use it as `0 + XMIN` (see the
   char-#define gotcha in the raytracer README) */
#define XMIN  192          /*  24 * 8 */
#define XMAX 2560          /* 320 * 8 */
#define YMAX 1832          /* 229 * 8 */
#define GRAVITY 3

copy64(src, dst)
char *src, *dst;
{
  int i;
  for (i = 0; i < 64; ++i)
    dst[i] = src[i];
}

main()
{
  int x, y, vx, vy, px;
  char frame;

  /* sprite data must sit on 64-byte boundaries in the VIC bank:
     blocks 128..130 = $2000, $2040, $2080 */
  copy64(ball0, 0x2000);
  copy64(ball1, 0x2040);
  copy64(ball2, 0x2080);

  putchar(147);              /* clear the screen */
  border = 12;               /* medium grey frame ... */
  background = 15;           /* ... around workbench-grey, roughly */
  spr0_col = 2;              /* red */
  spr_mc1 = 1;               /* white */
  spr_mc = 1;                /* sprite 0 multicolor on */
  spr0_ptr = 128;

  x = 800;  y = 480;         /* start at (100, 60) */
  spr0_x = 100;
  spr_xmsb = 0;
  spr0_y = 60;
  spr_enable = 1;            /* position set — now show it */

  vx = 16;  vy = 0;          /* 16 = exactly 2 px/frame: no 1px/2px beat */
  frame = 0;

  for (;;) {
    while (raster == 251) ;  /* one update per frame */
    while (raster != 251) ;

    vy = vy + GRAVITY;
    x = x + vx;
    y = y + vy;
    if (x < 0 + XMIN) { x = 0 + XMIN; vx = -vx; }
    if (x > XMAX) { x = XMAX; vx = -vx; }
    if (y > YMAX) { y = YMAX; vy = -vy; }

    px = x >> 3;
    spr0_x = px;             /* low byte */
    spr_xmsb = px > 255;     /* 9th bit */
    spr0_y = y >> 3;

    /* spin one column per frame, against the direction of travel: the
       checker shift (2 px) exactly cancels the 2 px/frame movement, so
       the pattern stays fixed in space and the ball rolls smoothly */
    if (vx > 0) { ++frame; if (frame == 3) frame = 0; }
    else { if (frame == 0) frame = 3; --frame; }
    spr0_ptr = 128 + frame;
  }
}
