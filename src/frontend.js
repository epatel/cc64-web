// Wires preprocessor + scanner + symbol table into the compiler front end.
// (The parser/codegen will consume `scanner` tokens and `symtab`;
// `pp.layout` carries the #pragma cc64 module configuration.)

import { Scanner } from './scanner.js';
import { Preprocessor } from './preprocessor.js';
import { SymTab } from './symtab.js';

export function makeFrontend({ source, fileName = 'main.c', fs = new Map(), diag }) {
  const diagnostics = [];
  const report = diag ?? ((msg) => diagnostics.push(msg));
  const symtab = new SymTab(report);
  const pp = new Preprocessor({ fs, symtab, diag: report });
  pp.pushFile(fileName, source);
  const scanner = new Scanner(pp);
  pp.scanner = scanner;
  return { scanner, symtab, pp, diagnostics };
}
