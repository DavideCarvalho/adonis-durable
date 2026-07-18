import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VERSION as DASHBOARD_VERSION } from '../src/dashboard/index.js';
import { VERSION } from '../src/index.js';

/** Guards the drift the exported `VERSION` literals had against `package.json` (they were left at
 *  `0.7.0` while the package shipped `0.9.0`). No build-time sync exists, so this is the guard:
 *  bump `package.json` and forget the literal → this fails. Mutation-proven by reverting either literal. */
describe('exported VERSION literal', () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version: string };

  it('matches the package.json version', () => {
    expect(VERSION).toBe(pkg.version);
  });

  it('the dashboard sub-export matches too', () => {
    expect(DASHBOARD_VERSION).toBe(pkg.version);
  });
});
