info: menu select

menu:
	echo "1 make test                 - run full test suite (incl. byte-identity diff)"
	echo "2 make web                  - dev server at http://localhost:8064/web/"
	echo "3 make diff                 - differential compile test only"
	echo "4 make golden SRC=f.c       - build golden PRG via real cc64 in VICE (needs CC64_REPO)"
	echo "5 make prg SRC=f.c          - compile f.c to f.prg with cc64-web"
	echo "6 make bench PRG=f.prg      - cycle-exact benchmark on the 6502 harness"
	echo "7 make update_phony         - update .PHONY in Makefile"

select:
	read -p ">>> " P ; make menu | grep "^$$P " | cut -d ' ' -f2-3 | bash

.SILENT:

.PHONY: info menu select test web diff golden prg bench update_phony

test:
	npm test

web:
	npm run web

diff:
	node test/compile.test.mjs

golden:
	test -n "$(SRC)" || (echo "usage: make golden SRC=test/fixtures/foo.c CC64_REPO=<cc64 checkout>" && exit 1)
	tools/oracle/cc64-compile.sh $(SRC) test/fixtures/golden/$$(basename $(SRC) .c).prg

prg:
	test -n "$(SRC)" || (echo "usage: make prg SRC=foo.c [OUT=foo.prg]" && exit 1)
	node --input-type=module -e "\
	import { readFileSync, readdirSync, writeFileSync } from 'node:fs'; \
	import { compile } from './src/compile.js'; \
	const fs = new Map(); \
	for (const f of readdirSync('assets/rt')) { \
	  const raw = readFileSync('assets/rt/' + f); \
	  fs.set(f, /\.(h|c)$$/.test(f) ? raw.toString('latin1') : new Uint8Array(raw)); \
	} \
	const src = readFileSync('$(SRC)', 'utf8'); \
	const res = compile({ source: src, fileName: '$(SRC)', fs }); \
	if (!res.prg) { console.error(res.diagnostics.join('\n')); process.exit(1); } \
	const out = '$(OUT)' || '$(SRC)'.replace(/\.c$$/, '.prg'); \
	writeFileSync(out, res.prg); \
	console.log(out + ': ' + res.prg.length + ' bytes');"

bench:
	test -n "$(PRG)" || (echo "usage: make bench PRG=file.prg" && exit 1)
	node tools/bench6502.mjs $(PRG)

update_phony:
	echo "##### Updating .PHONY targets #####"
	targets=$$(grep -E '^[a-zA-Z_][a-zA-Z0-9_-]*:' Makefile | grep -v '=' | cut -d: -f1 | tr '\n' ' '); \
	sed -i.bak "s/^\.PHONY:.*/.PHONY: $$targets/" Makefile && \
	echo "Updated .PHONY: $$targets" && \
	rm -f Makefile.bak
