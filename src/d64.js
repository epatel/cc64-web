// Minimal D64 (1541) disk image reader/writer.
// Enough to: list the directory, read a file, scratch a file, and write
// SEQ/PRG files into an existing image — i.e. inject a C source into the
// cc64 compile disk and extract the compiled PRG afterwards.

import { ascii2petscii, petscii2ascii } from './petscii.js';

const TRACKS = 35;
const DIR_TRACK = 18;
const D64_SIZE = 174848;

export const FILETYPE = { DEL: 0x80, SEQ: 0x81, PRG: 0x82 };

function sectorsPerTrack(t) {
  if (t <= 17) return 21;
  if (t <= 24) return 19;
  if (t <= 30) return 18;
  return 17;
}

function blockOffset(t, s) {
  let off = 0;
  for (let i = 1; i < t; i++) off += sectorsPerTrack(i);
  return (off + s) * 256;
}

function nameToPetscii(name) {
  const out = new Uint8Array(16).fill(0xa0);
  for (let i = 0; i < Math.min(16, name.length); i++) {
    out[i] = ascii2petscii(name.charCodeAt(i));
  }
  return out;
}

function petsciiToName(bytes) {
  let out = '';
  for (const b of bytes) {
    if (b === 0xa0) break;
    out += String.fromCharCode(petscii2ascii(b));
  }
  return out;
}

export class D64 {
  constructor(image) {
    if (image.length !== D64_SIZE) {
      throw new Error(`expected ${D64_SIZE}-byte 35-track D64, got ${image.length}`);
    }
    this.data = new Uint8Array(image); // own copy; caller keeps original
  }

  block(t, s) {
    const off = blockOffset(t, s);
    return this.data.subarray(off, off + 256);
  }

  get bam() {
    return this.block(DIR_TRACK, 0);
  }

  isFree(t, s) {
    const e = 4 + (t - 1) * 4;
    return (this.bam[e + 1 + (s >> 3)] >> (s & 7)) & 1;
  }

  setAllocated(t, s) {
    const e = 4 + (t - 1) * 4;
    if (!this.isFree(t, s)) return;
    this.bam[e + 1 + (s >> 3)] &= ~(1 << (s & 7));
    this.bam[e]--;
  }

  setFree(t, s) {
    const e = 4 + (t - 1) * 4;
    if (this.isFree(t, s)) return;
    this.bam[e + 1 + (s >> 3)] |= 1 << (s & 7);
    this.bam[e]++;
  }

  blocksFree() {
    let n = 0;
    for (let t = 1; t <= TRACKS; t++) {
      if (t !== DIR_TRACK) n += this.bam[4 + (t - 1) * 4];
    }
    return n;
  }

  // Allocate a free sector, preferring tracks near the directory like the
  // 1541 DOS does (18 itself is reserved for the directory).
  allocSector() {
    const order = [];
    for (let d = 1; d <= 17; d++) {
      if (DIR_TRACK - d >= 1) order.push(DIR_TRACK - d);
      if (DIR_TRACK + d <= TRACKS) order.push(DIR_TRACK + d);
    }
    for (const t of order) {
      for (let s = 0; s < sectorsPerTrack(t); s++) {
        if (this.isFree(t, s)) {
          this.setAllocated(t, s);
          return { t, s };
        }
      }
    }
    throw new Error('disk full');
  }

  *dirEntries() {
    let t = DIR_TRACK, s = 1;
    const seen = new Set();
    while (t !== 0 && !seen.has(`${t}/${s}`)) {
      seen.add(`${t}/${s}`);
      const blk = this.block(t, s);
      for (let i = 0; i < 8; i++) {
        yield { blk, entry: blk.subarray(i * 32, i * 32 + 32), t, s, slot: i };
      }
      t = blk[0];
      s = blk[1];
    }
  }

  list() {
    const files = [];
    for (const { entry } of this.dirEntries()) {
      const type = entry[2];
      if ((type & 0x07) === 0 || (type & 0x80) === 0) continue;
      files.push({
        name: petsciiToName(entry.subarray(5, 21)),
        type: ['DEL', 'SEQ', 'PRG', 'USR', 'REL'][type & 0x07] ?? '???',
        blocks: entry[0x1e] | (entry[0x1f] << 8),
      });
    }
    return files;
  }

  findEntry(name) {
    for (const e of this.dirEntries()) {
      const { entry } = e;
      if ((entry[2] & 0x80) === 0) continue;
      if (petsciiToName(entry.subarray(5, 21)) === name) return e;
    }
    return null;
  }

  readFile(name) {
    const found = this.findEntry(name);
    if (!found) throw new Error(`file not found: ${name}`);
    const chunks = [];
    let t = found.entry[3], s = found.entry[4];
    const seen = new Set();
    while (t !== 0) {
      const key = `${t}/${s}`;
      if (seen.has(key)) throw new Error(`cyclic sector chain in ${name}`);
      seen.add(key);
      const blk = this.block(t, s);
      const last = blk[0] === 0;
      chunks.push(blk.subarray(2, last ? blk[1] + 1 : 256));
      t = blk[0];
      s = blk[1];
    }
    const size = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  scratchFile(name) {
    const found = this.findEntry(name);
    if (!found) return false;
    let t = found.entry[3], s = found.entry[4];
    const seen = new Set();
    while (t !== 0 && !seen.has(`${t}/${s}`)) {
      seen.add(`${t}/${s}`);
      const blk = this.block(t, s);
      this.setFree(t, s);
      t = blk[0];
      s = blk[1];
    }
    found.entry[2] = 0; // scratched
    return true;
  }

  findFreeDirSlot() {
    let lastBlk = null;
    for (const e of this.dirEntries()) {
      if ((e.entry[2] & 0x80) === 0) return e.entry;
      lastBlk = e;
    }
    // Directory full: chain a new sector in track 18.
    for (let s = 1; s < sectorsPerTrack(DIR_TRACK); s++) {
      if (this.isFree(DIR_TRACK, s)) {
        this.setAllocated(DIR_TRACK, s);
        lastBlk.blk[0] = DIR_TRACK;
        lastBlk.blk[1] = s;
        const blk = this.block(DIR_TRACK, s);
        blk.fill(0);
        blk[1] = 0xff;
        return blk.subarray(0, 32);
      }
    }
    throw new Error('directory full');
  }

  writeFile(name, bytes, type = FILETYPE.SEQ) {
    this.scratchFile(name);
    const entry = this.findFreeDirSlot();
    const sectors = [];
    for (let off = 0; off < Math.max(1, bytes.length); off += 254) {
      sectors.push(bytes.subarray(off, Math.min(off + 254, bytes.length)));
    }
    const chain = sectors.map(() => this.allocSector());
    sectors.forEach((chunk, i) => {
      const { t, s } = chain[i];
      const blk = this.block(t, s);
      blk.fill(0);
      if (i + 1 < chain.length) {
        blk[0] = chain[i + 1].t;
        blk[1] = chain[i + 1].s;
      } else {
        blk[0] = 0;
        blk[1] = chunk.length + 1;
      }
      blk.set(chunk, 2);
    });
    const preserveLink = entry.byteOffset % 256 === 0; // first entry holds chain link
    const link = [entry[0], entry[1]];
    entry.fill(0);
    if (preserveLink) { entry[0] = link[0]; entry[1] = link[1]; }
    entry[2] = type;
    entry[3] = chain[0].t;
    entry[4] = chain[0].s;
    entry.set(nameToPetscii(name), 5);
    entry[0x1e] = chain.length & 0xff;
    entry[0x1f] = chain.length >> 8;
    return chain.length;
  }

  toBytes() {
    return this.data;
  }
}
