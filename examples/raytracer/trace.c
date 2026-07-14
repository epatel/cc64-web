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
int t_t, t_nx, t_ny, t_nz, t_ndl, t_dn;
char t_difs, t_s;

int sample_ray(ox, oy, oz, vx, vy, vz)
int ox, oy, oz, vx, vy, vz;
{
  if (vy >= 0) {
    r_shade = 1 + (vy >> 4);
    if (r_shade > SKY_MAX) r_shade = SKY_MAX;
    return r_shade;
  }
  r_t2 = fdiv(FLOOR_Y - oy, vy);
  if (r_t2 < 0) { r_shade = SHD_HAZE; return r_shade; }
  if (r_t2 >= 0x2000) { r_shade = SHD_HAZE; return r_shade; }
  r_hx = ox + fmul(r_t2, vx);
  r_hz = oz + fmul(r_t2, vz);
  if (((r_hx >> 8) + (r_hz >> 8)) & 1)
    r_shade = SHD_CHK_HI;
  else
    r_shade = SHD_CHK_LO;
  /* shadow ray from (hx, FLOOR_Y, hz) toward L, a = 1 since L is unit */
  r_hzc = r_hz - SPH_CZ;
  if (r_hx < SHADOW_RAW && r_hx > -SHADOW_RAW &&
      r_hzc < SHADOW_RAW && r_hzc > -SHADOW_RAW) {
    r_sb = fmul(r_hx, LGT_X) + OCY_LY + fmul(r_hzc, LGT_Z);
    if (r_sb < 0) {
      r_sc = fmul(r_hx, r_hx) + CC_SH + fmul(r_hzc, r_hzc);
      if (fmul(r_sb, r_sb) - r_sc > 0)
        r_shade = r_shade >> 2;
    }
  }
  return r_shade;
}

int trace_sphere(dx, dy, a, b, disc)
int dx, dy, a, b, disc;
{
  t_t = fdiv(b - fsqrt(disc), a);
  if (t_t <= 0) { t_s = 255; return t_s; }   /* fall back to floor/sky */
  t_nx = fmul(t_t, dx);          /* P = t*D; N = P - C (Cx = 0) */
  t_ny = fmul(t_t, dy) - SPH_CY;
  t_nz = t_t - SPH_CZ;
  t_ndl = fmul(t_nx, LGT_X) + fmul(t_ny, 0 + LGT_Y) + fmul(t_nz, LGT_Z);
  t_difs = 0;
  if (t_ndl > 0) t_difs = (12 * t_ndl) >> 8;
  t_dn = (fmul(dx, t_nx) + fmul(dy, t_ny) + t_nz) << 1;
  t_s = sample_ray(t_nx, t_ny + SPH_CY, t_t,
                   dx - fmul(t_dn, t_nx),
                   dy - fmul(t_dn, t_ny),
                   256 - fmul(t_dn, t_nz));
  t_s = (t_s >> 1) + t_difs + 1;
  if (t_s > 15) t_s = 15;
  return t_s;
}
