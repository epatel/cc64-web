#!/bin/bash
# Compile a C file with cc64 (running inside local VICE) and emit a .prg.
# Usage: CC64_REPO=<cc64 checkout> demo/cc64-compile.sh myprog.c [out.prg]
# The source must follow cc64's small-C subset and include a runtime header,
# e.g.: #include "rt-c64-08-9f.h"
set -e
cd "$(dirname "$0")/../.."

SRC="${1:?usage: cc64-compile.sh file.c [out.prg]}"
OUT="${2:-${SRC%.c}.prg}"
NAME=$(basename "$SRC" .c | tr '[:upper:]' '[:lower:]')
VICE_BIN="${VICE_BIN:-/Applications/vice-arm64-sdl2-3.9/bin/x64sc}"
CC64_REPO="${CC64_REPO:?set CC64_REPO to a pzembrod/cc64 checkout}"
WORK=$(mktemp -d)
trap 'kill $VICEPID 2>/dev/null || true' EXIT

node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
import { buildCompileDisk } from './src/index.js';
writeFileSync('$WORK/work.d64', buildCompileDisk(
  readFileSync('assets/cc64-c64files.d64'),
  [{ name: '$NAME.c', text: readFileSync('$SRC', 'utf8') }]));
"

SDL_AUDIODRIVER=dummy "$VICE_BIN" \
  -default -virtualdev8 +drive8truedrive +sound -drive8type 1541 \
  -8 "$WORK/work.d64" \
  -autostart "$CC64_REPO/autostart-c64/cc64.T64" \
  -keybuf "cc $NAME.c\n" \
  -warp > "$WORK/vice.log" 2>&1 &
VICEPID=$!

for i in $(seq 1 150); do
  sleep 2
  node --input-type=module -e "
    import { readFileSync } from 'node:fs';
    import { D64 } from './src/d64.js';
    const d = new D64(readFileSync('$WORK/work.d64'));
    process.exit(d.list().some(f => f.name === '$NAME' && f.type === 'PRG') ? 0 : 1);
  " 2>/dev/null && { sleep 3; break; }
done

kill $VICEPID 2>/dev/null || true; sleep 1; kill -9 $VICEPID 2>/dev/null || true

node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
import { extractPrg } from './src/index.js';
const prg = extractPrg(readFileSync('$WORK/work.d64'), '$NAME.c');
writeFileSync('$OUT', prg);
console.log('$OUT:', prg.length, 'bytes, load address $' + (prg[0] | prg[1] << 8).toString(16));
"
