/* protos.h - forward declarations.
 * The unity build concatenates .c files alphabetically, so calls across
 * files need cc64 prototypes (3-byte jmp stubs, patched by the linker). */

int isqrt();
int fmul();
int fdiv();
int fsqrt();
int sample_ray();
int trace_pixel();
int init_video();
