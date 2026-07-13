#include "rt-c64-08-9f.h"

extern _fastcall char chrout() *= 0xffd2;

int forward();

int vals[5] = { 1, 2, 3, 4, 5 };
char msg[] = "torture";
char buf[10];
int counter;

int twice(n)
int n;
{
  return n + n;
}

int apply(f, x)
int (*f)();
int x;
{
  return (*f)(x);
}

main()
{
  int i;
  int *p;
  char c;
  i = 0;
  p = vals;
  while (i < 5) {
    counter += *p++;
    ++i;
  }
  for (i = 9; i >= 0; --i)
    buf[i] = i;
  do {
    counter--;
  } while (counter > 100);
  switch (counter & 3) {
    case 0: counter += 1; break;
    case 1: counter += 2; break;
    default: counter += 3;
  }
  i = counter > 10 ? twice(counter) : forward(counter);
  if (i > 0 && counter != 0 || i == 5)
    chrout('y');
  else
    chrout('n');
  c = msg[2];
  chrout(c);
  i = apply(twice, 3);
  counter = i << 2;
  counter = counter >> 1;
  counter = -counter;
  counter = ~counter;
  counter = !counter;
  i = counter % 7;
  i = i * 3 / 2;
  chrout('0' + (i & 15));
}

int forward(n)
int n;
{
  return n - 1;
}
