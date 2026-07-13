/* fixmath.c - signed 8.8 fixed-point math for cc64 (16-bit ints only).
 *
 * cc64 semantics that matter here (verified against the runtime):
 * - >> is an ARITHMETIC shift (sign-extending)
 * - / and % floor toward minus infinity (we only divide positives)
 */

#include "rt-c64-08-9f.h"
#include "protos.h"

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

/* 8.8 * 8.8 -> 8.8 (truncating); exact modulo 2^16.
 * cc64's >> is an ARITHMETIC shift: a>>8 gives the signed high byte
 * directly, and the al*bl term (which can wrap negative as a 16-bit
 * product) needs its sign-extension masked off. */
int fmul(a, b)
int a, b;
{
  int al, bl;
  al = a & 255;
  bl = b & 255;
  return (((a >> 8) * (b >> 8)) << 8) + (a >> 8) * bl + al * (b >> 8)
       + (((al * bl) >> 8) & 255);
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
      r = r << 1;
      f = f << 1;
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
