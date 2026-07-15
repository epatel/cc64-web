/* protos.h - forward declarations.
 * The unity build concatenates .c files alphabetically, so calls across
 * files need cc64 prototypes (3-byte jmp stubs, patched by the linker). */

int init_tables();
int isqrt();
int fmul();
int fsq();
int fdiv();
int fsqrt();
int sample_ray();
int trace_sphere();
int init_video();
