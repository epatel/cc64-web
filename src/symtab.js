// Symbol table — port of symboltable.fth.
//
// The original packs counted strings + payload cells into a 64K buffer with
// a hash table; we keep JS Maps but preserve the exact interface semantics:
//   findlocal / putlocal / nestlocal / unnestlocal / findglobal / putglobal
// - names are significant to 31 chars (/id), silently truncated
// - putlocal rejects a name already defined in the *current* {} block
//   ()block mark), but shadowing an outer block or a global is fine
// - findlocal searches innermost block first (the original scans the local
//   table from most-recent entry upward)
// - a double definition reports a diagnostic and returns a fresh dummy
//   payload so compilation can continue (the original's `dummy`)
//
// A symbol payload is 2 cells in the original (type, value); we mirror that
// as { type, value } plus a name for diagnostics.

const ID_MAX = 31; // /id

const trim = (name) => name.slice(0, ID_MAX);

export class SymTab {
  constructor(diag = (msg) => { throw new Error(msg); }) {
    this.diag = diag;
    this.globals = new Map();
    this.blocks = [new Map()]; // local scopes, innermost last
  }

  makePayload(name) {
    return { name, type: 0, value: 0 };
  }

  // ---- locals ----
  resetLocals() { this.blocks = [new Map()]; }
  nestlocal() { this.blocks.push(new Map()); }
  unnestlocal() {
    if (this.blocks.length <= 1) this.diag('unnestlocal without nestlocal');
    else this.blocks.pop();
  }

  findlocal(name) {
    name = trim(name);
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const s = this.blocks[i].get(name);
      if (s) return s;
    }
    return null;
  }

  putlocal(name) {
    name = trim(name);
    const block = this.blocks[this.blocks.length - 1];
    if (block.has(name)) {
      this.diag(`double definition: ${name}`);
      return this.makePayload(name); // dummy
    }
    const s = this.makePayload(name);
    block.set(name, s);
    return s;
  }

  // ---- globals ----
  findglobal(name) {
    return this.globals.get(trim(name)) ?? null;
  }

  putglobal(name) {
    name = trim(name);
    if (this.globals.has(name)) {
      this.diag(`double definition: ${name}`);
      return this.makePayload(name); // dummy
    }
    const s = this.makePayload(name);
    this.globals.set(name, s);
    return s;
  }
}
