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
 * fdiv reuse the cells - all three are leaves that never call each other. */
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

/* integer square root of n (0..32767).
 * Scratch: m_r = r, m_t = bit, m_u = t, m_a = n */
int isqrt(n)
int n;
{
  m_r = 0;
  m_t = 0x4000;
  while (m_t > n)
    m_t = m_t >> 2;
  m_a = n;
  while (m_t != 0) {
    m_u = m_r + m_t;
    m_r = m_r >> 1;
    if (m_a >= m_u) {
      m_a = m_a - m_u;
      m_r = m_r + m_t;
    }
    m_t = m_t >> 2;
  }
  return m_r;
}

/* 8.8 * 8.8 -> 8.8, truncating toward zero (sign-magnitude), mod 2^16.
 * The asm original's fmul/umul16, reduced to the two product bytes the
 * 8.8 result needs: byte1 = >P0 + <P1 + <P2, byte2 = >P1 + >P2 + <P3
 * (+ carries), P0..P3 the four 8x8 partials. Each partial is two
 * table rows subtracted: SQR1[a+b] - SQR2[(255-a)+b], with a / 255-a
 * patched into the operand bytes and b in Y. */
int fmul(a, b)
int a, b;
{
  m_a = a;
  m_b = b;
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

/* 8.8 / 8.8 -> 8.8, saturating at +/-127.996.
 * Scratch: m_s = neg, m_a = q, m_r = r, m_t = f, m_u = i, m_b = b */
int fdiv(a, b)
int a, b;
{
  if (b == 0) return 32767;
  m_s = 0;
  if (a < 0) { a = -a; m_s = 1; }
  if (b < 0) { b = -b; m_s = 1 - m_s; }
  m_a = a / b;
  if (m_a > 126) {
    m_a = 32767;
  } else {
    m_r = a % b;
    m_b = b;
    m_t = 0;
    m_u = 8;
    while (m_u) {
      m_r = m_r + m_r;
      m_t = m_t + m_t;
      if (m_r >= m_b || m_r < 0) {   /* m_r < 0 catches the 16-bit wrap */
        m_r = m_r - m_b;
        m_t = m_t + 1;
      }
      m_u = m_u - 1;
    }
    m_a = (m_a << 8) + m_t;
  }
  if (m_s) return -m_a;
  return m_a;
}

/* sqrt of an 8.8 value (>= 0) -> 8.8; isqrt seed + one Newton step.
 * s_y is live across the fdiv call, so it gets its own zp cell. */
__zeropage int s_y;

int fsqrt(x)
int x;
{
  if (x <= 0) return 0;
  s_y = isqrt(x) << 4;
  if (s_y == 0) return 0;
  return (s_y + fdiv(x, s_y)) >> 1;
}
