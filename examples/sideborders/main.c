#include "rt-c64-08-9f.h"

/* sprites in the SIDE borders — a ghost sits in the left border and another
 * in the right border, places the VIC-II normally clips sprites away. This
 * is the hard cousin of the lower-border trick (examples/ghosts): opening a
 * side border means performing the 40/38-column switch at an exact cycle on
 * EVERY raster line, so it needs a cycle-stable raster.
 *
 * A double interrupt removes the raster entry jitter: irq1 fires a line
 * early, chains to irq2 and sleeps in a NOP sled; irq2's `txs` cancels the
 * jitter. Then a loop that is exactly 63 cycles per raster line toggles
 * $d016 to 38 columns just before the 40-column right compare and back, so
 * the compare is skipped and the side-border flip-flop is never set — the
 * VIC keeps drawing background and sprites out to the screen edges. We run
 * it inside the lower border (opened first with the 24-row RSEL trick), so
 * there are no badlines to disturb the timing.
 *
 * Sprite DMA steals CPU cycles on the lines a sprite is shown, which shifts
 * the timing; the tuning (the NOP counts below) is therefore calibrated
 * with these sprites present. See README.md.
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

extern _fastcall putchar() *= 0xffd2;

copy64(src, dst)
char *src, *dst;
{
  int i;
  for (i = 0; i < 64; ++i)
    dst[i] = src[i];
}

install()
{
  __asm {
    jmp setup

  irq1:                ; line 249, jittery: chain to irq2 and sleep
    lda #<irq2
    sta $0314
    lda #>irq2
    sta $0315
    inc $d012
    lda #$ff
    sta $d019
    tsx
    cli
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop

  irq2:                ; line 250: txs cancels the entry jitter
    txs
    bit $02            ; 3-cycle fine align: lands the $d016 write mid-window
    lda #$13           ; 24-row -> lower border opens
    sta $d011
    ldx #44
  sbl:                 ; each pass is exactly 63 cycles = one raster line
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    lda #$00
    sta $d016          ; 38 col, skipping the 40-col right compare
    lda #$08
    sta $d016          ; 40 col back
    nop
    nop
    nop
    nop
    dex
    bne sbl
    lda #$08
    sta $d016
    lda #$1b           ; 25-row again for the next frame
    sta $d011
    lda #<irq1
    sta $0314
    lda #>irq1
    sta $0315
    lda #249
    sta $d012
    lda #$ff
    sta $d019
    jmp $ea81

  setup:
    sei
    lda #$7f
    sta $dc0d
    sta $dd0d
    lda $dc0d
    lda $dd0d
    lda #$01
    sta $d01a
    lda $d011
    and #$7f
    sta $d011
    lda #249
    sta $d012
    lda #<irq1
    sta $0314
    lda #>irq1
    sta $0315
    lda #$ff
    sta $d019
    cli
  }
}

title()
{
  char *msg;
  msg = "   sprites in the side borders";
  while (*msg) putchar(*msg++);
}

main()
{
  char *vic, *sptr;

  copy64(ghost, 0x2000);

  putchar(147);
  title();
  vic = 0xd000;
  sptr = 0x07f8;
  vic[0x20] = 14;              /* border light blue */
  vic[0x21] = 0;               /* background black */
  vic[0x1c] = 0;               /* hires */
  vic[0x27] = 1;               /* sprite 0 white */
  vic[0x28] = 1;               /* sprite 1 white */
  sptr[0] = 128;
  sptr[1] = 128;
  vic[0] = 6;                  /* sprite 0 X: far left border */
  vic[1] = 250;                /* Y: top of the opened band */
  vic[2] = 78;                 /* sprite 1 X low (334 = $14e) */
  vic[3] = 250;
  vic[0x10] = 2;               /* sprite 1 9th X bit (right border) */
  vic[0x17] = 3;               /* Y-expand 0,1 so they fill the band —
                                  every opened line then has the same
                                  2-sprite DMA, keeping the timing uniform */
  vic[0x15] = 3;               /* enable sprites 0,1 */

  install();

  for (;;) ;                   /* the IRQ does all the work */
}
