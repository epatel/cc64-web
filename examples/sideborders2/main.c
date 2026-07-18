#include "rt-c64-08-9f.h"

/* sprites in the LEFT and RIGHT borders, at frame height (beside the screen).
 *
 *   +-------------------+
 *   |   |   title   |   |
 *   +---+-----------+---+
 *   | D |           | F |   D: ghost at X=4   (left border, Y=105)
 *   |   |           |   |   F: ghost at X=340 (right border, Y=105)
 *   +---+-----------+---+
 *   |   |           |   |
 *   +-------------------+
 *
 * The per-line recipe is the naive one from https://stackoverflow.com/a/1477560 :
 * on every line the ghosts occupy, delay to just before the right-edge compare,
 * flip $d016 to 38 columns (the compare is skipped), then flip back to 40 — so
 * the side-border flip-flop is never set and both borders open. A `bit $02`
 * gives the loop the odd cycle a PAL line (63 cycles) needs.
 *
 * The window is only ~1 cycle wide, so it needs a rock-stable raster. A single
 * IRQ + a "poor man's" cmp stabiliser leaves ~2-3 cycles of jitter — enough to
 * miss the window on most lines (tried it; it only opened part of the band).
 * So this uses the DOUBLE-INTERRUPT stabiliser: irq1 fires a line early, chains
 * to irq2 and sleeps in a NOP sled; irq2's `txs` discards the jittered stack
 * frame, leaving a cycle-exact entry. Everything after that (the per-line loop)
 * is still the plain naive loop.
 *
 * Two things differ from a lower-border opener (examples/sideborders):
 *  - The band sits INSIDE the display window (lines 108..124), so the vertical
 *    border is already open there and the left edge opens on its own — no
 *    24-row RSEL trick needed.
 *  - Inside the window there are badlines, which would steal ~40 cycles and
 *    wreck the per-line timing. So each line rewrites $d011 YSCROLL to
 *    (line&7)^4 (FLD): the badline compare (line&7 == YSCROLL) never matches.
 *
 * The ghosts are NOT Y-expanded (an expanded sprite fetches data only every
 * other line, which would make the loop's sprite-DMA cost alternate line by
 * line) and sit at Y=105 so the whole 108..124 band is inside their rows —
 * every band line then sees the same 2-sprite DMA.
 *
 * The cycle constants (the sled/prologue lengths and the DA/DB NOP split around
 * the flip) are tuned on a real raster: the compiler does not know cycle counts
 * and the pure-CPU harness has no VIC DMA. Verified stable and full-height in
 * VICE (0 pixels differ between frames). PAL only; NTSC (65 cyc/line) re-tunes.
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

  irq1:                ; line 106, jittery: chain to irq2 and sleep in a sled
    lda #<irq2
    sta $0314
    lda #>irq2
    sta $0315
    inc $d012          ; next compare: line 107
    lda #$ff
    sta $d019
    tsx
    cli
    .byte $ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea
    .byte $ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea
    .byte $ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea
    .byte $ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea
    .byte $ea,$ea,$ea,$ea,$ea
    jmp $ea81          ; irq1's own exit: irq2's rti resumes inside this sled

  irq2:                ; line 107: txs discards the jittered stack frame
    txs
    bit $02            ; 3-cycle fine align onto the window
    ; prologue: consume the rest of line 107 so the loop's first flip lands in
    ; line 108's right-edge window                                 [TUNE]
    .byte $ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea
    ldy #4             ; FLD parity: first drawn line is 108, 108&7 = 4
    ldx #17            ; cover lines 108..124 (inside the sprites at Y=105..125)
  band:                ; one pass per line: exactly 63 cycles (jitter-free now)
    ; --- FLD: keep this line from being a badline (yscroll != line&7)
    tya
    and #$07
    eor #$04
    ora #$18           ; DEN on, 25 rows, yscroll=(line&7)^4
    sta $d011
    iny
    ; --- DA: delay to just before the 40-col right compare       [TUNE]
    bit $02            ; 3 cyc: odd-cycle nudge
    nop
    nop
    nop
    ; --- the flip: 40 -> 38 -> 40 straddling the right-edge compare
    lda #$00
    sta $d016          ; 38 columns: the 40-col right compare does not fire
    lda #$08
    sta $d016          ; 40 columns back: neither compare set the border FF
    ; --- DB: delay to fill out the rest of the 63-cycle line      [TUNE]
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    dex
    bne band

    lda #$08
    sta $d016          ; leave in 40 columns
    lda #$1b
    sta $d011          ; restore 25 rows / yscroll 3 for the rest
    lda #<irq1
    sta $0314
    lda #>irq1
    sta $0315
    lda #106
    sta $d012
    lda #$ff
    sta $d019
    jmp $ea81

  setup:
    sei
    lda #$7f
    sta $dc0d          ; disable all CIA#1 interrupt sources (jiffy IRQ, etc.)
    sta $dd0d          ; disable all CIA#2 interrupt sources
    lda $dc0d          ; read ICRs to clear any pending CIA IRQ
    lda $dd0d
    lda #$01
    sta $d01a          ; enable ONLY the VIC raster interrupt
    lda $d011
    and #$7f
    sta $d011          ; clear raster-compare high bit
    lda #106
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
  msg = "   sprites beside the frame";
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
  vic[1] = 105;               /* Y: frame height; band 108..124 sits inside */
  vic[2] = 78;                 /* sprite 1 X low (334 = $14e) */
  vic[3] = 105;
  vic[0x10] = 2;               /* sprite 1 9th X bit: far right border */
  vic[0x17] = 0;               /* NOT Y-expanded: uniform DMA every band line */
  vic[0x15] = 3;               /* enable sprites 0,1 */

  install();

  for (;;) ;                   /* the IRQ does all the work */
}
