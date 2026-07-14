/* scene.h - raytracer scene definition (signed 8.8 constants)
 *
 * One mirror sphere, directional light, checkered floor, sky.
 * Ported from inspiration-raytracer/scene.asm.
 *
 * Derived constants must be kept in sync by hand:
 *   SPH_C2R = cy*cy + cz*cz - r*r
 *   OCY_LY  = (FLOOR_Y - SPH_CY) * LGT_Y
 *   CC_SH   = (FLOOR_Y - SPH_CY)^2 - r*r
 */

/* sphere: center (0, SPH_CY, SPH_CZ), radius 1.0 */
#define SPH_CY  0x0080
#define SPH_CZ  0x0200
#define SPH_C2R 0x0340

/* directional light, unit vector pointing toward the light */
#define LGT_X   0xff98
#define LGT_Y   0x00d1
#define LGT_Z   0xff98

/* shadow-ray constants (ocy = FLOOR_Y - SPH_CY = -1.5) */
#define OCY_LY  0xfec7
#define CC_SH   0x0140
#define SHADOW_RAW 0x0600

/* C.L = SPH_CY*LGT_Y + SPH_CZ*LGT_Z = 0x68 - 0xd0 (N.L = t*(D.L) - C.L) */
#define C_DOT_L 0xff98

/* floor and shading */
#define FLOOR_Y 0xff00
#define SHD_CHK_HI 13
#define SHD_CHK_LO 3
#define SHD_HAZE   1
#define SKY_MAX    12
