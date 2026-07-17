#include "rt-c64-08-9f.h"

/* boing — a red/white checkered ball (hello, Amiga) bouncing around the
 * screen, drawn with cc64-web's __sprite extension.
 *
 * The six sprites are the same ball with the checker pattern rotated by
 * one column each — the full period, since the checkers repeat every 6
 * columns (3 red + 3 white). The frame is picked straight from the x
 * position ((px/2) % 6), which locks the checkers to the screen so the
 * ball rolls over them — no drift, any speed, either direction.
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

__sprite ball3 = {
  .... --oo ....
  ...- --oo o...
  ..o- --oo o...
  .oo- --oo o-..
  .oo- --oo o-..
  .--o oo-- -oo.
  ---o oo-- -oo.
  ---o oo-- -oo.
  ---o oo-- -oo.
  ---o oo-- -oo.
  ooo- --oo o---
  ooo- --oo o--.
  ooo- --oo o--.
  ooo- --oo o--.
  ooo- --oo o--.
  .--o oo-- -oo.
  .--o oo-- -o..
  .--o oo-- -o..
  ..-o oo-- -...
  ...o oo-- -...
  .... --oo ....
};

__sprite ball4 = {
  .... -ooo ....
  ...- -ooo -...
  ..-- -ooo -...
  .o-- -ooo --..
  .o-- -ooo --..
  .-oo o--- ooo.
  --oo o--- ooo.
  --oo o--- ooo.
  --oo o--- ooo.
  --oo o--- ooo.
  oo-- -ooo ---o
  oo-- -ooo ---.
  oo-- -ooo ---.
  oo-- -ooo ---.
  oo-- -ooo ---.
  .-oo o--- ooo.
  .-oo o--- oo..
  .-oo o--- oo..
  ..oo o--- o...
  ...o o--- o...
  .... -ooo ....
};

__sprite ball5 = {
  .... ooo- ....
  ...- ooo- -...
  ..-- ooo- -...
  .--- ooo- --..
  .--- ooo- --..
  .ooo ---o oo-.
  -ooo ---o oo-.
  -ooo ---o oo-.
  -ooo ---o oo-.
  -ooo ---o oo-.
  o--- ooo- --oo
  o--- ooo- --o.
  o--- ooo- --o.
  o--- ooo- --o.
  o--- ooo- --o.
  .ooo ---o oo-.
  .ooo ---o oo..
  .ooo ---o oo..
  ..oo ---o o...
  ...o ---o o...
  .... ooo- ....
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
#define GRAVITY 1

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

  /* sprite data must sit on 64-byte boundaries in the VIC bank:
     blocks 128..133 = $2000..$2140 */
  copy64(ball0, 0x2000);
  copy64(ball1, 0x2040);
  copy64(ball2, 0x2080);
  copy64(ball3, 0x20c0);
  copy64(ball4, 0x2100);
  copy64(ball5, 0x2140);

  putchar(147);              /* clear the screen */
  border = 12;               /* medium grey frame ... */
  background = 15;           /* ... around workbench-grey, roughly */
  spr0_col = 2;              /* red */
  spr_mc1 = 1;               /* white */
  spr_mc = 1;                /* sprite 0 multicolor on */
  spr0_ptr = 130;            /* start phase: (100/2) % 6 = 2 */

  x = 800;  y = 480;         /* start at (100, 60) */
  spr0_x = 100;
  spr_xmsb = 0;
  spr0_y = 60;
  spr_enable = 1;            /* position set — now show it */

  vx = 8;  vy = 0;           /* 8 = exactly 1 px/frame — slow Amiga drift;
                                emulator frame-pacing jitter scales with
                                speed, so slower also looks steadier */

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

    /* pick the spin frame straight from the x position: each frame
       shifts the checkers one column (2 px), and the full pattern
       period is 6 columns (3 red + 3 white), so (px/2) % 6 over six
       frames keeps the pattern locked to the screen while the ball
       rolls over it — with only half the phases the checkers would
       color-flip every 6 px */
    spr0_ptr = 128 + (px >> 1) % 6;
  }
}
