// Unity-build preprocessing: concatenate a project's .c files into a single
// translation unit. All #include directives are hoisted to the top, deduped,
// in first-seen order — so the runtime-module header's #pragma cc64 is
// processed before any code, as cc64 requires. cc64's forward-call patching
// (protos2patch) means function definition order across files is free.
//
// Include lines inside /* */ comments are left alone (not hoisted).

const INCLUDE = /^\s*#include\s+("[^"]+"|<[^>]+>)\s*$/;

export function amalgamate(files) {
  const cFiles = [...(files instanceof Map ? files.keys() : Object.keys(files))]
    .filter((n) => n.endsWith('.c'))
    .sort();
  if (cFiles.length === 0) throw new Error('project has no .c files');
  const get = (n) => (files instanceof Map ? files.get(n) : files[n]);

  const includes = [];
  const seen = new Set();
  const collect = (spec) => {
    const name = spec.slice(1, -1);
    if (!seen.has(name)) { seen.add(name); includes.push(`#include ${spec}`); }
  };

  const bodies = cFiles.map((name) => {
    const out = [];
    let inComment = false;
    for (const line of get(name).split('\n')) {
      const startedInComment = inComment;
      // track /* */ state across the line (strings can't span lines in cc64)
      for (let i = 0; i < line.length; i++) {
        if (inComment) { if (line[i] === '*' && line[i + 1] === '/') { inComment = false; i++; } }
        else if (line[i] === '/' && line[i + 1] === '*') { inComment = true; i++; }
        else if (line[i] === '"' || line[i] === "'") {
          const q = line[i];
          for (i++; i < line.length && line[i] !== q; i++) if (line[i] === '\\') i++;
        }
      }
      const m = !startedInComment && line.match(INCLUDE);
      if (m) collect(m[1]);
      else out.push(line);
    }
    return `/* ==== ${name} ==== */\n${out.join('\n').replace(/\n+$/, '')}\n`;
  });

  return {
    source: `${includes.join('\n')}\n\n${bodies.join('\n')}`,
    files: cFiles,
    includes: [...seen],
  };
}
