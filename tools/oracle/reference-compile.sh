#!/bin/bash
# End-to-end proof of the browser flow, using local VICE as a stand-in for
# a web VICE (web64.nofs.ai):
#   1. buildCompileDisk() injects hello2.c into the cc64 disk image
#   2. VICE boots cc64 from the image (drive 8) and types `cc hello2.c`
#   3. extractPrg() pulls the compiled PRG back out of the image
set -e
cd "$(dirname "$0")/../.."

VICE_BIN="${VICE_BIN:-/Applications/vice-arm64-sdl2-3.9/bin/x64sc}"
CC64_REPO="${CC64_REPO:?set CC64_REPO to a pzembrod/cc64 checkout (for autostart-c64/cc64.T64)}"
WORK=$(mktemp -d)
trap 'kill $VICEPID 2>/dev/null || true' EXIT

node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
import { buildCompileDisk } from './src/index.js';
const base = readFileSync('assets/cc64-c64files.d64');
const src = readFileSync('test/hello2.c', 'utf8');
writeFileSync('$WORK/work.d64', buildCompileDisk(base, [{ name: 'hello2.c', text: src }]));
console.log('compile disk written to $WORK/work.d64');
"

SDL_AUDIODRIVER=dummy "$VICE_BIN" \
  -default -virtualdev8 +drive8truedrive +sound -drive8type 1541 \
  -8 "$WORK/work.d64" \
  -autostart "$CC64_REPO/autostart-c64/cc64.T64" \
  -keybuf 'cc hello2.c\n' \
  -warp > "$WORK/vice.log" 2>&1 &
VICEPID=$!

echo "waiting for cc64 to write hello2 PRG into the image..."
for i in $(seq 1 120); do
  sleep 2
  if node --input-type=module -e "
    import { readFileSync } from 'node:fs';
    import { D64 } from './src/d64.js';
    const d = new D64(readFileSync('$WORK/work.d64'));
    process.exit(d.list().some(f => f.name === 'hello2' && f.type === 'PRG') ? 0 : 1);
  " 2>/dev/null; then
    sleep 3  # let the drive finish flushing
    break
  fi
done

kill $VICEPID 2>/dev/null || true; sleep 1; kill -9 $VICEPID 2>/dev/null || true

node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
import { extractPrg } from './src/index.js';
const prg = extractPrg(readFileSync('$WORK/work.d64'), 'hello2.c');
writeFileSync('$WORK/hello2.prg', prg);
const la = prg[0] | (prg[1] << 8);
console.log('extracted hello2.prg:', prg.length, 'bytes, load address $' + la.toString(16));
if (la !== 0x0801) throw new Error('unexpected load address');
"
echo "e2e OK — PRG at $WORK/hello2.prg"
