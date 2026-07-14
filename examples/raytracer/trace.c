/* trace.c - per-pixel ray tracing. Port of inspiration-raytracer/trace.asm.
 *
 * trace_sphere(dx, dy, a, b, disc) -> shade 0-15, or 255 = miss (t <= 0)
 *
 * D = (dx, dy, 1)   dx = (px-160)/128, dy = (100-py)/128  (unnormalized)
 * Sphere (half-b quadratic):
 *   a = D.D,  b = D.C,  c = |C|^2 - r^2 (SPH_C2R)
 *   disc = b*b - a*c ; hit if disc >= 0 ; t = (b - sqrt)/a
 * Hit: N = t*D - C (unit, r = 1) is never materialized - with a and b
 *      in hand: g = D.N = t*a - b, N.L = t*(D.L) - C.L, and
 *      R = D - 2g*N = k*D + 2g*C, k = 1 - 2g*t (Cy, Cz terms are shifts).
 *      DIFS = 12*max(0, N.L); sample floor/sky along R from P = t*D
 *      (P computed only when R points floor-ward - sky needs no origin);
 *      shade = sample/2 + DIFS + 1 (half mirror + diffuse)
 * Miss: sample floor/sky along D from the origin.
 * Floor: t2 = (FLOOR_Y - oy)/vy, checker = parity of floor(x)+floor(z);
 *        t2 >= 32 -> horizon haze. Shadow ray toward L vs the sphere,
 *        tested only within +/-6 units so squares fit in 8.8;
 *        in shadow -> quarter brightness.
 * Sky:   shade = 1 + vy/16, clamped to SKY_MAX.
 */

#include "rt-c64-08-9f.h"
#include "scene.h"
#include "protos.h"

/* Working vars at file scope (globals are ~2x faster than locals; the zp
 * pool is already full). Prefixed: the unity build is one namespace. */
int r_t2, r_hx, r_hz, r_hzc, r_sb, r_sc;
char r_shade;
int t_t, t_nx, t_ny, t_ndl, t_g, t_k, t_dl, t_rx, t_ry, t_rz;
char t_difs, t_s;

/* fixmath calling convention: operands go directly into the zp cells
 * m_a/m_b (declared in fixmath.c), the functions take no parameters -
 * see fixmath.c. Argument expressions are kept verbatim (incl. the
 * 0 + NAME int-promotions for char-typed #defines). */

int sample_ray(ox, oy, oz, vx, vy, vz)
int ox, oy, oz, vx, vy, vz;
{
  if (vy >= 0) {
    r_shade = 1 + (vy >> 4);
    if (r_shade > SKY_MAX) r_shade = SKY_MAX;
    return r_shade;
  }
  m_a = FLOOR_Y - oy;
  m_b = vy;
  r_t2 = fdiv();
  if (r_t2 < 0) { r_shade = SHD_HAZE; return r_shade; }
  if (r_t2 >= 0x2000) { r_shade = SHD_HAZE; return r_shade; }
  m_a = r_t2;
  m_b = vx;
  r_hx = ox + fmul();
  m_a = r_t2;
  m_b = vz;
  r_hz = oz + fmul();
  if (((r_hx >> 8) + (r_hz >> 8)) & 1)
    r_shade = SHD_CHK_HI;
  else
    r_shade = SHD_CHK_LO;
  /* shadow ray from (hx, FLOOR_Y, hz) toward L, a = 1 since L is unit */
  r_hzc = r_hz - SPH_CZ;
  if (r_hx < SHADOW_RAW && r_hx > -SHADOW_RAW &&
      r_hzc < SHADOW_RAW && r_hzc > -SHADOW_RAW) {
    m_a = r_hx;
    m_b = LGT_X;
    r_sb = fmul() + OCY_LY;
    m_a = r_hzc;
    m_b = LGT_Z;
    r_sb = r_sb + fmul();
    if (r_sb < 0) {
      m_a = r_hx;
      m_b = r_hx;
      r_sc = fmul() + CC_SH;
      m_a = r_hzc;
      m_b = r_hzc;
      r_sc = r_sc + fmul();
      m_a = r_sb;
      m_b = r_sb;
      if (fmul() - r_sc > 0)
        r_shade = r_shade >> 2;
    }
  }
  return r_shade;
}

int trace_sphere(dx, dy, a, b, disc)
int dx, dy, a, b, disc;
{
  m_a = disc;
  t_t = b - fsqrt();
  m_a = t_t;
  m_b = a;
  t_t = fdiv();
  if (t_t <= 0) { t_s = 255; return t_s; }   /* fall back to floor/sky */
  /* N = t*D - C never materializes: with a = D.D, b = D.C in hand,
   * g = D.N = t*a - b, N.L = t*(D.L) - C.L (D.L's dy*ly + lz part is
   * per-row: r_dl from main), and R = D - 2g*N = k*D + 2g*C with
   * k = 1 - 2g*t - the C terms are shifts (Cx = 0, Cy = 0.5, Cz = 2). */
  m_a = dx;
  m_b = LGT_X;
  t_dl = fmul() + r_dl;          /* D.L */
  m_a = t_t;
  m_b = t_dl;
  t_ndl = fmul() - C_DOT_L;      /* N.L */
  t_difs = 0;
  if (t_ndl > 0) t_difs = (12 * t_ndl) >> 8;
  m_a = t_t;
  m_b = a;
  t_g = fmul() - b;              /* D.N (< 0 at a front hit) */
  m_a = t_g;
  m_b = t_t;
  t_k = 256 - (fmul() << 1);     /* 1 - 2g*t */
  m_a = t_k;
  m_b = dx;
  t_rx = fmul();
  m_a = t_k;
  m_b = dy;
  t_ry = fmul() + t_g;           /* + 2g*Cy = g */
  t_rz = t_k + (t_g << 2);       /* k*dz (dz = 1) + 2g*Cz */
  if (t_ry >= 0) {               /* sky-bound: P = t*D never needed */
    t_s = 1 + (t_ry >> 4);
    if (t_s > SKY_MAX) t_s = SKY_MAX;
  } else {
    m_a = t_t;
    m_b = dx;
    t_nx = fmul();               /* P = t*D: reflection origin */
    m_a = t_t;
    m_b = dy;
    t_ny = fmul();
    t_s = sample_ray(t_nx, t_ny, t_t, t_rx, t_ry, t_rz);
  }
  t_s = (t_s >> 1) + t_difs + 1;
  if (t_s > 15) t_s = 15;
  return t_s;
}
