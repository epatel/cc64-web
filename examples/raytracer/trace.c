/* trace.c - per-pixel ray tracing. Port of inspiration-raytracer/trace.asm.
 *
 * trace_pixel(px, py) -> shade 0-15
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

int sample_ray(ox, oy, oz, vx, vy, vz)
int ox, oy, oz, vx, vy, vz;
{
  int t2, hx, hz, hzc, sb, sc;
  char shade;
  if (vy >= 0) {
    shade = 1 + (vy >> 4);
    if (shade > SKY_MAX) shade = SKY_MAX;
    return shade;
  }
  t2 = fdiv(FLOOR_Y - oy, vy);
  if (t2 < 0) { shade = SHD_HAZE; return shade; }
  if (t2 >= 0x2000) { shade = SHD_HAZE; return shade; }
  hx = ox + fmul(t2, vx);
  hz = oz + fmul(t2, vz);
  if (((hx >> 8) + (hz >> 8)) & 1)
    shade = SHD_CHK_HI;
  else
    shade = SHD_CHK_LO;
  /* shadow ray from (hx, FLOOR_Y, hz) toward L, a = 1 since L is unit */
  hzc = hz - SPH_CZ;
  if (hx < SHADOW_RAW && hx > -SHADOW_RAW &&
      hzc < SHADOW_RAW && hzc > -SHADOW_RAW) {
    sb = fmul(hx, LGT_X) + OCY_LY + fmul(hzc, LGT_Z);
    if (sb < 0) {
      sc = fmul(hx, hx) + CC_SH + fmul(hzc, hzc);
      if (fmul(sb, sb) - sc > 0)
        shade = shade >> 2;
    }
  }
  return shade;
}

int trace_pixel(px, py)
int px, py;
{
  int dx, dy, a, b, disc, t;
  int nx, ny, nz, ndl, dn;
  char difs, s;
  dx = (px - 160) << 1;
  dy = (100 - py) << 1;
  a = fmul(dx, dx) + fmul(dy, dy) + 256;
  b = fmul(dy, 0 + SPH_CY) + SPH_CZ;
  disc = fmul(b, b) - fmul(a, SPH_C2R);
  if (disc >= 0) {
    t = fdiv(b - fsqrt(disc), a);
    if (t > 0) {
      nx = fmul(t, dx);          /* P = t*D; N = P - C (Cx = 0) */
      ny = fmul(t, dy) - SPH_CY;
      nz = t - SPH_CZ;
      ndl = fmul(nx, LGT_X) + fmul(ny, 0 + LGT_Y) + fmul(nz, LGT_Z);
      difs = 0;
      if (ndl > 0) difs = (12 * ndl) >> 8;
      dn = (fmul(dx, nx) + fmul(dy, ny) + nz) << 1;
      s = sample_ray(nx, ny + SPH_CY, t,
                     dx - fmul(dn, nx),
                     dy - fmul(dn, ny),
                     256 - fmul(dn, nz));
      s = (s >> 1) + difs + 1;
      if (s > 15) s = 15;
      return s;
    }
  }
  return sample_ray(0, 0, 0, dx, dy, 256);
}
