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

int init_tables()
{
  int i, q;
  q = 0;
  for (i = 0; i < 511; ++i) {
    qsq[i] = q;
    q = q + ((i + 1) >> 1);     /* q(n+1) = q(n) + floor((n+1)/2) */
  }
}

/* integer square root of n (0..32767) */
int isqrt(n)
int n;
{
  int r, bit, t;
  r = 0;
  bit = 0x4000;
  while (bit > n)
    bit = bit >> 2;
  while (bit != 0) {
    t = r + bit;
    r = r >> 1;
    if (n >= t) {
      n = n - t;
      r = r + bit;
    }
    bit = bit >> 2;
  }
  return r;
}

/* 8.8 * 8.8 -> 8.8, truncating toward zero (sign-magnitude).
 * Working variables live in the zero page (cc64-web 'zeropage' extension):
 * globals beat locals ((frame),y indirection), and zp beats absolute by a
 * cycle per access - it all adds up at this call rate. */
zeropage int m_ah, m_al, m_bh, m_bl, m_t, m_u, m_r, m_s;

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

/* 8.8 / 8.8 -> 8.8, saturating at +/-127.996 */
int fdiv(a, b)
int a, b;
{
  int neg, q, r, f, i;
  if (b == 0) return 32767;
  neg = 0;
  if (a < 0) { a = -a; neg = !neg; }
  if (b < 0) { b = -b; neg = !neg; }
  q = a / b;
  if (q > 126) {
    q = 32767;
  } else {
    r = a % b;
    f = 0;
    i = 8;
    while (i) {
      r = r + r;
      f = f + f;
      if (r >= b || r < 0) {   /* r < 0 catches the 16-bit wrap */
        r = r - b;
        f = f + 1;
      }
      i = i - 1;
    }
    q = (q << 8) + f;
  }
  if (neg) return -q;
  return q;
}

/* sqrt of an 8.8 value (>= 0) -> 8.8; isqrt seed + one Newton step */
int fsqrt(x)
int x;
{
  int y;
  if (x <= 0) return 0;
  y = isqrt(x) << 4;
  if (y == 0) return 0;
  return (y + fdiv(x, y)) >> 1;
}
