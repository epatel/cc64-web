/* fixmath.c - signed 8.8 fixed-point math for cc64 (16-bit ints only).
 *
 * cc64 semantics that matter here (verified against the runtime):
 * - >> is an ARITHMETIC shift (sign-extending)
 * - / and % floor toward minus infinity (we only divide positives)
 *
 * fmul is the asm original's quarter-square multiply, ported into a
 * cc64-web __asm block: 8x8 products come straight from page-aligned
 * byte tables (a*b = f(a+b) - f(|a-b|), f(n) = floor(n*n/4)), with the
 * operand bytes PATCHED into the lookup instructions (self-modifying)
 * and the |a-b| index handled by the complement trick - no compares.
 * init_tables() must run before the first fmul.
 */

#include "rt-c64-08-9f.h"
#include "protos.h"

/* quarter-square tables, 512 bytes each, page-aligned in the free RAM
 * behind the VIC bank-3 screen ($c400-$c7e7) */
#define SQR1LO 0xc800  /* <f(i)      i = 0..510 */
#define SQR1HI 0xca00  /* >f(i)              */
#define SQR2LO 0xcc00  /* <f(|i-255|)        */
#define SQR2HI 0xce00  /* >f(|i-255|)        */

/* Shared zero-page scratch (cc64-web '__zeropage' extension): declared
 * first, the compiler is single-pass. fmul owns the naming; isqrt and
 * fdiv reuse the cells - all three are leaves that never call each other.
 *
 * Calling convention: these functions take NO parameters - the caller
 * stores the operands into m_a (and m_b) directly and calls fmul() /
 * fdiv() / isqrt() / fsqrt(). Skipping cc64's parameter passing (stack
 * push + (frame),y reload + zp store) saves ~82 cycles per 2-arg call.
 * The price is sequencing discipline: between setting m_a/m_b and the
 * call, nothing may call another fixmath function. */
__zeropage int m_a, m_b, m_r, m_t, m_u, m_s;

int init_tables()
{
  int i, j, q;
  char *s1l, *s1h, *s2l, *s2h;
  s1l = SQR1LO;
  s1h = SQR1HI;
  s2l = SQR2LO;
  s2h = SQR2HI;
  q = 0;
  for (i = 0; i < 511; ++i) {
    s1l[i] = q & 255;
    s1h[i] = (q >> 8) & 255;
    q = q + ((i + 1) >> 1);     /* f(n+1) = f(n) + floor((n+1)/2) */
  }
  for (i = 0; i < 511; ++i) {   /* SQR2[i] = f(|i - 255|) */
    j = (i < 255) ? 255 - i : i - 255;
    s2l[i] = s1l[j];
    s2h[i] = s1h[j];
  }
}

/* integer square root of m_a (0..32767): the binary bit-method, in asm so
 * the shifts are lsr/ror instead of runtime $shr calls (~67 cycles each).
 * Scratch: m_r = r, m_t = bit, m_u = t, m_a = n. m_b/m_s untouched. */
int isqrt()
{
  __asm {
    lda #0
    sta m_r
    sta m_r+1
    sta m_t
    lda #64             ; bit = $4000
    sta m_t+1
  salign:               ; while (bit > n) bit >>= 2
    lda m_t+1
    cmp m_a+1
    bcc smain           ; bit_hi < n_hi
    bne sshift          ; bit_hi > n_hi
    lda m_t
    cmp m_a
    bcc smain
    beq smain           ; bit == n
  sshift:
    lsr m_t+1
    ror m_t
    lsr m_t+1
    ror m_t
    jmp salign
  smain:                ; while (bit != 0)
    lda m_t
    ora m_t+1
    beq sdone
    clc                 ; t = r + bit
    lda m_r
    adc m_t
    sta m_u
    lda m_r+1
    adc m_t+1
    sta m_u+1
    lsr m_r+1           ; r >>= 1
    ror m_r
    lda m_a+1           ; if (n >= t) { n -= t; r += bit }
    cmp m_u+1
    bcc snext
    bne stake
    lda m_a
    cmp m_u
    bcc snext
  stake:
    sec
    lda m_a
    sbc m_u
    sta m_a
    lda m_a+1
    sbc m_u+1
    sta m_a+1
    clc
    lda m_r
    adc m_t
    sta m_r
    lda m_r+1
    adc m_t+1
    sta m_r+1
  snext:
    lsr m_t+1           ; bit >>= 2
    ror m_t
    lsr m_t+1
    ror m_t
    jmp smain
  sdone:
  }
  return m_r;
}

/* 8.8 * 8.8 -> 8.8, truncating toward zero (sign-magnitude), mod 2^16.
 * The asm original's fmul/umul16, reduced to the two product bytes the
 * 8.8 result needs: byte1 = >P0 + <P1 + <P2, byte2 = >P1 + >P2 + <P3
 * (+ carries), P0..P3 the four 8x8 partials. Each partial is two
 * table rows subtracted: SQR1[a+b] - SQR2[(255-a)+b], with a / 255-a
 * patched into the operand bytes and b in Y. */
int fmul()      /* operands in m_a, m_b */
{
  __asm {
    lda m_a+1
    eor m_b+1
    sta m_s             ; bit 7 = result sign
    lda m_a+1
    bpl apos
    sec                 ; a = -a
    lda #0
    sbc m_a
    sta m_a
    lda #0
    sbc m_a+1
    sta m_a+1
  apos:
    lda m_b+1
    bpl bpos
    sec                 ; b = -b
    lda #0
    sbc m_b
    sta m_b
    lda #0
    sbc m_b+1
    sta m_b+1
  bpos:
    lda m_a             ; patch AL into the AL-partials
    sta pa1+1
    sta pa2+1
    sta pa5+1
    sta pa6+1
    eor #255
    sta pa3+1
    sta pa4+1
    sta pa7+1
    sta pa8+1
    lda m_a+1           ; patch AH into the AH-partials
    sta pb1+1
    sta pb2+1
    sta pb5+1
    eor #255
    sta pb3+1
    sta pb4+1
    sta pb7+1

    ldy m_b
    sec                 ; P0 = AL*BL (high byte only; the low-byte sbc
  pa1:                  ;             still sets the borrow)
    lda SQR1LO,y
  pa3:
    sbc SQR2LO,y
  pa2:
    lda SQR1HI,y
  pa4:
    sbc SQR2HI,y
    sta m_t             ; >P0
    sec                 ; P2 = AH*BL
  pb1:
    lda SQR1LO,y
  pb3:
    sbc SQR2LO,y
    sta m_u             ; <P2
  pb2:
    lda SQR1HI,y
  pb4:
    sbc SQR2HI,y
    sta m_u+1           ; >P2
    ldy m_b+1
    sec                 ; P1 = AL*BH
  pa5:
    lda SQR1LO,y
  pa7:
    sbc SQR2LO,y
    sta m_r             ; <P1
  pa6:
    lda SQR1HI,y
  pa8:
    sbc SQR2HI,y
    sta m_r+1           ; >P1
    sec                 ; P3 = AH*BH (low byte only)
  pb5:
    lda SQR1LO,y
  pb7:
    sbc SQR2LO,y
    tax                 ; <P3

    clc                 ; byte1 = >P0 + <P1 + <P2
    lda m_t             ; byte2 = >P1 + >P2 + <P3 (+ carries; byte3 dropped)
    adc m_r
    sta m_t
    lda m_r+1
    adc #0
    sta m_r+1
    clc
    lda m_t
    adc m_u
    sta m_r
    lda m_r+1
    adc m_u+1
    sta m_t
    clc
    txa
    adc m_t
    sta m_r+1

    lda m_s
    bpl mdone
    sec                 ; apply the sign
    lda #0
    sbc m_r
    sta m_r
    lda #0
    sbc m_r+1
    sta m_r+1
  mdone:
  }
  return m_r;
}

/* 8.8 / 8.8 -> 8.8, saturating at +/-127.996: the asm original's 24-step
 * shift-subtract long division Q = (|a| << 8) / |b|, but keeping this
 * port's stricter saturation (q > 126 -> 32767, sign applied after).
 * The 24-bit dividend/quotient register is m_u(lo) m_a m_a+1(hi):
 * quotient bits enter at the bottom as dividend bits leave the top.
 * Scratch: m_t = remainder, m_s = sign. */
int fdiv()      /* operands in m_a, m_b */
{
  if (m_b == 0) return 32767;
  __asm {
    lda m_a+1
    eor m_b+1
    sta m_s             ; bit 7 = result sign
    lda m_a+1
    bpl dapos
    sec                 ; a = -a
    lda #0
    sbc m_a
    sta m_a
    lda #0
    sbc m_a+1
    sta m_a+1
  dapos:
    lda m_b+1
    bpl dbpos
    sec                 ; b = -b
    lda #0
    sbc m_b
    sta m_b
    lda #0
    sbc m_b+1
    sta m_b+1
  dbpos:
    lda #0
    sta m_u             ; dividend low byte (the << 8)
    sta m_t             ; remainder = 0
    sta m_t+1
    ldx #3              ; 3 passes x 8 unrolled steps = 24
  dloop:
    asl m_u             ; --- step 1 ---
    rol m_a
    rol m_a+1
    rol m_t
    rol m_t+1
    bcs d1f
    lda m_t+1
    cmp m_b+1
    bcc d1n
    bne d1f
    lda m_t
    cmp m_b
    bcc d1n
  d1f:
    lda m_t
    sec
    sbc m_b
    sta m_t
    lda m_t+1
    sbc m_b+1
    sta m_t+1
    inc m_u
  d1n:
    asl m_u             ; --- step 2 ---
    rol m_a
    rol m_a+1
    rol m_t
    rol m_t+1
    bcs d2f
    lda m_t+1
    cmp m_b+1
    bcc d2n
    bne d2f
    lda m_t
    cmp m_b
    bcc d2n
  d2f:
    lda m_t
    sec
    sbc m_b
    sta m_t
    lda m_t+1
    sbc m_b+1
    sta m_t+1
    inc m_u
  d2n:
    asl m_u             ; --- step 3 ---
    rol m_a
    rol m_a+1
    rol m_t
    rol m_t+1
    bcs d3f
    lda m_t+1
    cmp m_b+1
    bcc d3n
    bne d3f
    lda m_t
    cmp m_b
    bcc d3n
  d3f:
    lda m_t
    sec
    sbc m_b
    sta m_t
    lda m_t+1
    sbc m_b+1
    sta m_t+1
    inc m_u
  d3n:
    asl m_u             ; --- step 4 ---
    rol m_a
    rol m_a+1
    rol m_t
    rol m_t+1
    bcs d4f
    lda m_t+1
    cmp m_b+1
    bcc d4n
    bne d4f
    lda m_t
    cmp m_b
    bcc d4n
  d4f:
    lda m_t
    sec
    sbc m_b
    sta m_t
    lda m_t+1
    sbc m_b+1
    sta m_t+1
    inc m_u
  d4n:
    asl m_u             ; --- step 5 ---
    rol m_a
    rol m_a+1
    rol m_t
    rol m_t+1
    bcs d5f
    lda m_t+1
    cmp m_b+1
    bcc d5n
    bne d5f
    lda m_t
    cmp m_b
    bcc d5n
  d5f:
    lda m_t
    sec
    sbc m_b
    sta m_t
    lda m_t+1
    sbc m_b+1
    sta m_t+1
    inc m_u
  d5n:
    asl m_u             ; --- step 6 ---
    rol m_a
    rol m_a+1
    rol m_t
    rol m_t+1
    bcs d6f
    lda m_t+1
    cmp m_b+1
    bcc d6n
    bne d6f
    lda m_t
    cmp m_b
    bcc d6n
  d6f:
    lda m_t
    sec
    sbc m_b
    sta m_t
    lda m_t+1
    sbc m_b+1
    sta m_t+1
    inc m_u
  d6n:
    asl m_u             ; --- step 7 ---
    rol m_a
    rol m_a+1
    rol m_t
    rol m_t+1
    bcs d7f
    lda m_t+1
    cmp m_b+1
    bcc d7n
    bne d7f
    lda m_t
    cmp m_b
    bcc d7n
  d7f:
    lda m_t
    sec
    sbc m_b
    sta m_t
    lda m_t+1
    sbc m_b+1
    sta m_t+1
    inc m_u
  d7n:
    asl m_u             ; --- step 8 ---
    rol m_a
    rol m_a+1
    rol m_t
    rol m_t+1
    bcs d8f
    lda m_t+1
    cmp m_b+1
    bcc d8n
    bne d8f
    lda m_t
    cmp m_b
    bcc d8n
  d8f:
    lda m_t
    sec
    sbc m_b
    sta m_t
    lda m_t+1
    sbc m_b+1
    sta m_t+1
    inc m_u
  d8n:
    dex                 ; next pass (bne is out of range: ~340 bytes)
    beq dend
    jmp dloop
  dend:
    lda m_a+1           ; Q bits 16-23: q = Q >> 8 > 126 -> saturate
    bne dsat
    lda m_a             ; Q bits 8-15
    cmp #127
    bcc dok
  dsat:
    lda #255
    sta m_r
    lda #127
    sta m_r+1
    jmp dsign
  dok:
    lda m_u             ; result = Q low 16 bits
    sta m_r
    lda m_a
    sta m_r+1
  dsign:
    lda m_s
    bpl ddone
    sec                 ; apply the sign (also to the saturated 32767)
    lda #0
    sbc m_r
    sta m_r
    lda #0
    sbc m_r+1
    sta m_r+1
  ddone:
  }
  return m_r;
}

/* sqrt of an 8.8 value in m_a (>= 0) -> 8.8; isqrt seed + one Newton step.
 * s_y is live across the fdiv call, so it gets its own zp cell; x is
 * parked in m_b across isqrt (which spares m_b and m_s). */
__zeropage int s_y;

int fsqrt()     /* operand in m_a */
{
  if (m_a <= 0) return 0;
  m_b = m_a;
  s_y = isqrt() << 4;
  if (s_y == 0) return 0;
  m_a = m_b;
  m_b = s_y;
  return (s_y + fdiv()) >> 1;
}
