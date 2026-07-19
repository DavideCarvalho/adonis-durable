#!/usr/bin/env node
/**
 * Keeps the exported `VERSION` literals in `packages/adonis/src/index.ts` and
 * `packages/adonis/src/dashboard/index.ts` in sync with `packages/adonis/package.json`'s
 * `version` — the two literals have no other link to the package version (no build-time
 * codegen, no JSON import), so `changeset version` bumping the manifest alone silently drifts
 * them (see `test/version.spec.ts`, which exists specifically to catch that drift in CI).
 *
 * Run as the last step of the root `version-packages` script, right after `changeset version`
 * writes the new `package.json`, so a release always ships with the literals already matching —
 * `version.spec.ts` should never fail on a release branch again.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const pkgPath = `${repoRoot}packages/adonis/package.json`;
const literalFiles = [
  `${repoRoot}packages/adonis/src/index.ts`,
  `${repoRoot}packages/adonis/src/dashboard/index.ts`,
];

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const version = pkg.version;
if (!version) {
  throw new Error(`sync-version-literals: no "version" field in ${pkgPath}`);
}

const VERSION_LINE = /^export const VERSION = '[^']*';$/m;

for (const file of literalFiles) {
  const source = readFileSync(file, 'utf8');
  if (!VERSION_LINE.test(source)) {
    throw new Error(
      `sync-version-literals: no "export const VERSION = '...'" line found in ${file}`,
    );
  }
  const updated = source.replace(VERSION_LINE, `export const VERSION = '${version}';`);
  if (updated !== source) {
    writeFileSync(file, updated);
    console.log(`sync-version-literals: ${file} -> ${version}`);
  }
}
