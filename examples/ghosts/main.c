#include "rt-c64-08-9f.h"

/* ghosts in the border — sprites drawn below the normal screen, in the
 * lower border, using cc64-web's __sprite extension plus a raster
 * interrupt that opens the border.
 *
 * The VIC-II normally paints a solid border around the 25-row screen and
 * clips sprites to that inner rectangle. The lower border is turned on
 * when the raster reaches line 251 (the 25-row bottom compare). If we
 * switch to 24-row mode (RSEL=0, whose compare is line 247) *after* 247
 * has passed but *before* 251, neither compare ever fires and the border
 * flip-flop is never set — the VIC keeps drawing background + sprites all
 * the way down. A second interrupt near the top restores 25-row mode so
 * the trick repeats every frame. See README.md.
 *
 * Hires ghost: 24 . / x pixels per row, a single color ($d027, white);
 * the eyes are transparent holes that show the black background.
 */

__sprite ghost = {
  ........ xxxxxxxx ........
  .....xxx xxxxxxxx xxx.....
  ...xxxxx xxxxxxxx xxxxx...
  ..xxxxxx xxxxxxxx xxxxxx..
  .xxxxxxx xxxxxxxx xxxxxxx.
  .xxxxxxx xxxxxxxx xxxxxxx.
  xxxxxx.. .xxxxxx. ..xxxxxx
  xxxxx... ..xxxx.. ...xxxxx
  xxxxx... ..xxxx.. ...xxxxx
  xxxxx... ..xxxx.. ...xxxxx
  xxxxx... ..xxxx.. ...xxxxx
  xxxxxx.. .xxxxxx. ..xxxxxx
  xxxxxxxx xxxxxxxx xxxxxxxx
  xxxxxxxx xxxxxxxx xxxxxxxx
  xxxxxxxx xxxxxxxx xxxxxxxx
  xxxxxxxx xxxxxxxx xxxxxxxx
  xxxxxxxx xxxxxxxx xxxxxxxx
  xxxxxxxx xxxxxxxx xxxxxxxx
  .xxxx..x xxx..xxx x..xxxx.
  ..xx.... xx....xx ....xx..
  ........ ........ ........
};

/* vertical bob, one sine period in 32 steps (amplitude 4 px) */
char bob[32] = {
  4, 5, 6, 6, 7, 7, 8, 8, 8, 8, 8, 7, 7, 6, 6, 5,
  4, 3, 2, 2, 1, 1, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3
};

extern _fastcall putchar() *= 0xffd2;   /* KERNAL CHROUT */

copy64(src, dst)
char *src, *dst;
{
  int i;
  for (i = 0; i < 64; ++i)
    dst[i] = src[i];
}

/* install the two-interrupt lower-border opener (raw 6502) */
install()
{
  /* handlers come first so the setup's #<irqa / #>irqa are backward
     (resolved) references; the leading jmp skips them on the install call */
  __asm {
    jmp setup

  irqa:                ; ~line 250: switch to 24-row -> lower border open
    lda #$13           ; DEN=1, RSEL=0, yscroll=3
    sta $d011
    lda #40
    sta $d012          ; next compare near the top
    lda #<irqb
    sta $0314
    lda #>irqb
    sta $0315
    lda #$ff
    sta $d019
    jmp $ea81          ; pull A/X/Y, rti

  irqb:                ; ~line 40: restore 25-row for the next frame
    lda #$1b           ; DEN=1, RSEL=1, yscroll=3
    sta $d011
    lda #250
    sta $d012
    lda #<irqa
    sta $0314
    lda #>irqa
    sta $0315
    lda #$ff
    sta $d019
    jmp $ea81

  setup:
    sei
    lda #$7f
    sta $dc0d          ; mask CIA1 timer interrupts
    sta $dd0d          ; mask CIA2
    lda $dc0d          ; ack any pending
    lda $dd0d
    lda #$01
    sta $d01a          ; enable raster interrupts
    lda $d011
    and #$7f           ; raster-compare high bit = 0 (lines < 256)
    sta $d011
    lda #250
    sta $d012          ; first compare: the bottom trick line
    lda #<irqa
    sta $0314
    lda #>irqa
    sta $0315
    lda #$ff
    sta $d019          ; ack
    cli
  }
}

title()
{
  char *msg, *scr, *col, i;
  msg = "     ghosts in the border";
  while (*msg) putchar(*msg++);
  /* a solid floor bar on the last text row (24) marks the screen's edge;
     the ghosts float below it, in the opened border */
  scr = 0x0400 + 24 * 40;
  col = 0xd800 + 24 * 40;
  for (i = 0; i < 40; ++i) { scr[i] = 160; col[i] = 14; }   /* inverse space */
}

main()
{
  char *vic, *sptr;
  int frame;
  char i, p;

  copy64(ghost, 0x2000);       /* sprite block 128 */

  putchar(147);                /* clear screen */
  title();
  vic = 0xd000;
  sptr = 0x07f8;               /* sprite pointers, after the $0400 screen */
  vic[0x20] = 14;              /* border: light blue */
  vic[0x21] = 0;               /* background: black */
  vic[0x1c] = 0;               /* all sprites hires (monocolor) */

  for (i = 0; i < 8; ++i) {
    vic[i * 2] = 20 + i * 30;  /* X (all < 256) */
    vic[0x27 + i] = 1;         /* sprite color: white */
    sptr[i] = 128;             /* sprite pointer -> block 128 */
  }
  vic[0x10] = 0;               /* no X high bits */
  vic[0x15] = 255;             /* enable all 8 sprites */

  install();

  frame = 0;
  for (;;) {
    while (vic[0x12] != 100) ; /* one update per frame, mid-screen */
    ++frame;
    for (i = 0; i < 8; ++i) {
      p = (frame + i * 4) & 31;
      vic[i * 2 + 1] = 246 + bob[p];   /* Y, low in the open border */
    }
  }
}
