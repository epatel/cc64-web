/* trace.c - per-pixel ray tracing. Port of inspiration-raytracer/trace.asm.
 *
 * trace_sphere(dx, dy, a, b, disc) -> shade 0-15, or 255 = miss (t <= 0)
 *
 * D = (dx, dy, 1)   dx = (px-160)/128, dy = (100-py)/128  (unnormalized)
 * Sphere (half-b quadratic):
 *   a = D.D,  b = D.C,  c = |C|^2 - r^2 (SPH_C2R)
 *   disc = b*b - a*c ; hit if disc >= 0 ; t = (b - sqrt)/a
 * Hit: P = t*D, N = P - C (unit, r = 1), DIFS = 12*max(0, N.L),
 *      R = D - 2(D.N)N, sample floor/sky along R from P,
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
int t_t, t_nx, t_ny, t_nz, t_ndl, t_dn, t_rx, t_ry, t_rz;
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
  m_a = t_t;                     /* P = t*D; N = P - C (Cx = 0) */
  m_b = dx;
  t_nx = fmul();
  m_a = t_t;
  m_b = dy;
  t_ny = fmul() - SPH_CY;
  t_nz = t_t - SPH_CZ;
  m_a = t_nx;
  m_b = LGT_X;
  t_ndl = fmul();
  m_a = t_ny;
  m_b = 0 + LGT_Y;
  t_ndl = t_ndl + fmul();
  m_a = t_nz;
  m_b = LGT_Z;
  t_ndl = t_ndl + fmul();
  t_difs = 0;
  if (t_ndl > 0) t_difs = (12 * t_ndl) >> 8;
  m_a = dx;
  m_b = t_nx;
  t_dn = fmul();
  m_a = dy;
  m_b = t_ny;
  t_dn = (t_dn + fmul() + t_nz) << 1;
  m_a = t_dn;
  m_b = t_nx;
  t_rx = dx - fmul();
  m_a = t_dn;
  m_b = t_ny;
  t_ry = dy - fmul();
  m_a = t_dn;
  m_b = t_nz;
  t_rz = 256 - fmul();
  t_s = sample_ray(t_nx, t_ny + SPH_CY, t_t, t_rx, t_ry, t_rz);
  t_s = (t_s >> 1) + t_difs + 1;
  if (t_s > 15) t_s = 15;
  return t_s;
}
