/* fixmath.c - signed 8.8 fixed-point math for cc64 (16-bit ints only).
 *
 * cc64 semantics that matter here (verified against the runtime):
 * - >> is an ARITHMETIC shift (sign-extending)
 * - / and % floor toward minus infinity (we only divide positives)
 *
 * fmul avoids the runtime's software multiply entirely: 8x8 products come
 * from a table of squares (a*b = q[a+b] - q[|a-b|], exact), and byte
 * extraction/composition goes through char pointers instead of shift-by-8
 * runtime calls. init_tables() must run before the first fmul.
 */

#include "rt-c64-08-9f.h"
#include "protos.h"

int qsq[511];                   /* q[n] = floor(n*n/4), mod 2^16 */

/* Shared zero-page scratch (cc64-web 'zeropage' extension): declared first,
 * the compiler is single-pass. fmul owns the naming; isqrt and fdiv reuse
 * the cells - all three are leaves that never call each other. Globals beat
 * locals ((frame),y indirection), zp beats absolute by a cycle per access. */
zeropage int m_ah, m_al, m_bh, m_bl, m_t, m_u, m_r, m_s;

int init_tables()
{
  int i, q;
  q = 0;
  for (i = 0; i < 511; ++i) {
    qsq[i] = q;
    q = q + ((i + 1) >> 1);     /* q(n+1) = q(n) + floor((n+1)/2) */
  }
}

/* integer square root of n (0..32767).
 * Scratch reuses fmul's zeropage cells: fmul, fdiv and isqrt are leaves
 * that never call each other, so the cells are dead between calls.
 * m_r = r, m_t = bit, m_u = t, m_ah = n */
int isqrt(n)
int n;
{
  m_r = 0;
  m_t = 0x4000;
  while (m_t > n)
    m_t = m_t >> 2;
  m_ah = n;
  while (m_t != 0) {
    m_u = m_r + m_t;
    m_r = m_r >> 1;
    if (m_ah >= m_u) {
      m_ah = m_ah - m_u;
      m_r = m_r + m_t;
    }
    m_t = m_t >> 2;
  }
  return m_r;
}

/* 8.8 * 8.8 -> 8.8, truncating toward zero (sign-magnitude). */
int fmul(a, b)
int a, b;
{
  char *pb;
  m_s = 0;
  if (a < 0) { a = -a; m_s = 1; }
  if (b < 0) { b = -b; m_s = 1 - m_s; }
  pb = &a;
  m_al = pb[0];
  m_ah = pb[1];
  pb = &b;
  m_bl = pb[0];
  m_bh = pb[1];
  /* r = (a*b) >> 8 = ((ah*bh) << 8) + ah*bl + al*bh + ((al*bl) >> 8) */
  m_t = qsq[m_ah + m_bh];
  if (m_ah >= m_bh) m_t = m_t - qsq[m_ah - m_bh]; else m_t = m_t - qsq[m_bh - m_ah];
  m_u = 0;
  pb = &m_u;
  pb[1] = m_t;                  /* (ah*bh) << 8, no shift */
  m_r = m_u;
  m_t = qsq[m_ah + m_bl];
  if (m_ah >= m_bl) m_t = m_t - qsq[m_ah - m_bl]; else m_t = m_t - qsq[m_bl - m_ah];
  m_r = m_r + m_t;
  m_t = qsq[m_al + m_bh];
  if (m_al >= m_bh) m_t = m_t - qsq[m_al - m_bh]; else m_t = m_t - qsq[m_bh - m_al];
  m_r = m_r + m_t;
  m_t = qsq[m_al + m_bl];
  if (m_al >= m_bl) m_t = m_t - qsq[m_al - m_bl]; else m_t = m_t - qsq[m_bl - m_al];
  m_u = m_t;
  m_r = m_r + pb[1];            /* (al*bl) >> 8, no shift */
  if (m_s) return -m_r;
  return m_r;
}

/* 8.8 / 8.8 -> 8.8, saturating at +/-127.996.
 * Scratch reuses fmul's zeropage cells (leaf, see isqrt):
 * m_s = neg, m_ah = q, m_r = r, m_t = f, m_u = i, m_bl = b */
int fdiv(a, b)
int a, b;
{
  if (b == 0) return 32767;
  m_s = 0;
  if (a < 0) { a = -a; m_s = 1; }
  if (b < 0) { b = -b; m_s = 1 - m_s; }
  m_ah = a / b;
  if (m_ah > 126) {
    m_ah = 32767;
  } else {
    m_r = a % b;
    m_bl = b;
    m_t = 0;
    m_u = 8;
    while (m_u) {
      m_r = m_r + m_r;
      m_t = m_t + m_t;
      if (m_r >= m_bl || m_r < 0) {   /* m_r < 0 catches the 16-bit wrap */
        m_r = m_r - m_bl;
        m_t = m_t + 1;
      }
      m_u = m_u - 1;
    }
    m_ah = (m_ah << 8) + m_t;
  }
  if (m_s) return -m_ah;
  return m_ah;
}

/* sqrt of an 8.8 value (>= 0) -> 8.8; isqrt seed + one Newton step.
 * s_y is live across the fdiv call, so it gets its own zp cell. */
zeropage int s_y;

int fsqrt(x)
int x;
{
  if (x <= 0) return 0;
  s_y = isqrt(x) << 4;
  if (s_y == 0) return 0;
  return (s_y + fdiv(x, s_y)) >> 1;
}
