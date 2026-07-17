import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * STRUCTURAL proof that the `@adonis-agora/durable/worker` subpath is store-less: walk the transitive
 * `import` graph of `src/worker-runtime/index.ts` (the lean entry) and assert it NEVER reaches
 * `@adonisjs/lucid` or any store/db module. This is the design's "isolation is a structural fact"
 * (design §4) turned into an executable invariant — add a real Lucid import anywhere in the graph and
 * this test goes red (mutation-proven).
 *
 * Type-only imports (`import type …`) are elided by the compiler, so they never load a module at
 * runtime; the walker skips statement-level `import type`/`export type` and follows everything else
 * CONSERVATIVELY (an inline `import { type X }` is followed anyway — over-following can only ADD
 * reachable files, never hide a Lucid import).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../../src');
const ENTRY = resolve(SRC, 'worker-runtime/index.ts');

/** Forbidden runtime module specifiers + file-path fragments (anything store/Lucid/db). */
const FORBIDDEN_SPECIFIER = /^@adonisjs\/lucid(\/|$)/;
const FORBIDDEN_FILE = /(resolve-lucid-db|[/\\]stores[/\\]|[/\\]transports[/\\]db)/;

/** Extract the runtime (non-type-only) module specifiers imported/re-exported by a source file. */
function runtimeImportsOf(source: string): string[] {
  const specifiers: string[] = [];

  // `import ... from '<spec>'` and `export ... from '<spec>'`, skipping statement-level `type` forms.
  const fromRe = /(?:^|[\n;])\s*(import|export)\b([\s\S]*?)\bfrom\s*['"]([^'"]+)['"]/g;
  for (let m = fromRe.exec(source); m !== null; m = fromRe.exec(source)) {
    const clause = m[2] ?? '';
    // `import type …` / `export type …` — elided at compile time, never loads the module.
    if (/^\s+type\b/.test(clause)) continue;
    specifiers.push(m[3] as string);
  }

  // Bare side-effect imports: `import '<spec>'`.
  const sideEffectRe = /(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g;
  for (let m = sideEffectRe.exec(source); m !== null; m = sideEffectRe.exec(source)) {
    specifiers.push(m[1] as string);
  }

  return specifiers;
}

/** Resolve a relative `./x.js` import from `fromFile` back to its `.ts` source path. */
function resolveRelative(fromFile: string, spec: string): string {
  const base = resolve(dirname(fromFile), spec);
  return base.replace(/\.js$/, '.ts');
}

interface GraphWalk {
  files: Set<string>;
  bareSpecifiers: Set<string>;
}

function walkGraph(entry: string): GraphWalk {
  const files = new Set<string>();
  const bareSpecifiers = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);

    const source = readFileSync(file, 'utf8');
    for (const spec of runtimeImportsOf(source)) {
      if (spec.startsWith('.')) {
        queue.push(resolveRelative(file, spec));
      } else if (!spec.startsWith('node:')) {
        bareSpecifiers.add(spec);
      }
    }
  }

  return { files, bareSpecifiers };
}

describe('@adonis-agora/durable/worker — store-less by structure (no Lucid in the import graph)', () => {
  const { files, bareSpecifiers } = walkGraph(ENTRY);

  it('reaches a non-trivial graph (the walker actually followed imports)', () => {
    // Sanity: if the walker silently found nothing, the no-Lucid assertions below would be vacuous.
    expect(files.size).toBeGreaterThan(3);
    expect(files.has(resolve(SRC, 'worker-runtime/worker-runtime.ts'))).toBe(true);
    expect(files.has(resolve(SRC, 'handshake/descriptor.ts'))).toBe(true);
  });

  it('imports no @adonisjs/lucid (or any lucid subpath) anywhere in the graph', () => {
    const offenders = [...bareSpecifiers].filter((s) => FORBIDDEN_SPECIFIER.test(s));
    expect(
      offenders,
      `worker subpath must not import Lucid; found: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('reaches no store / db-transport / resolve-lucid-db source file', () => {
    const offenders = [...files].filter((f) => FORBIDDEN_FILE.test(f.replace(SRC, '')));
    expect(
      offenders,
      `worker subpath must not reach store modules; found: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
