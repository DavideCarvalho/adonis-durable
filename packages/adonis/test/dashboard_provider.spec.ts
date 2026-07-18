import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IgnitorFactory } from '@adonisjs/core/factories';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Regression test for a real crash: `@adonisjs/core/services/router` is a plain module-level
 * binding assigned only once inside `await app.booted(async () => { router = ... })` (see the
 * service's own source) — it is NOT a lazy proxy. Every provider `boot()` method runs BEFORE those
 * "booted" hooks fire, so a provider that calls `router.get(...)` synchronously inside its own
 * `boot()` crashes with "Cannot read properties of undefined (reading 'get')" — for every
 * entrypoint (`serve`, `ace`, tests) that registers it.
 *
 * This drives a REAL AdonisJS application (via `@adonisjs/core`'s own `IgnitorFactory`, the same
 * harness AdonisJS's `AceFactory` uses) through a real `register -> boot -> "booted" hooks`
 * lifecycle, with the real `@adonisjs/core/services/router` module in play, so it actually exercises
 * the ordering bug instead of a hand-rolled stand-in that can't reproduce it.
 */
describe('DashboardProvider — boots inside a real AdonisJS app', () => {
  let appRoot: string;

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), 'durable-dashboard-boot-'));
  });

  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true });
  });

  it('registers its routes without crashing app.boot()', async () => {
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        rcFileContents: {
          // A bare loader function, exactly how a real adonisrc.ts lists a package provider.
          providers: [() => import('../providers/dashboard_provider.js')],
        },
      })
      .create(pathToFileURL(`${appRoot}/`));

    const app = ignitor.createApp('web');
    await app.init();

    // This is the crash site: DashboardProvider#boot() used to call `router.get(...)` directly,
    // and `router` (the module-level binding) is `undefined` at this point in the real lifecycle.
    await expect(app.boot()).resolves.toBeUndefined();

    // Not just "didn't throw" — prove the routes actually made it onto the router before the app
    // is considered booted (registering them any later, e.g. in a provider `ready()` hook, would be
    // too late: the HTTP server commits the router before providers' `ready()` runs).
    const router = await app.container.make<{
      commit(): void;
      toJSON(): { root: Array<{ name?: string }> };
    }>('router');
    router.commit();
    const routeNames = router.toJSON().root.map((route) => route.name);

    expect(routeNames).toEqual(
      expect.arrayContaining([
        'durable_dashboard.index',
        'durable_dashboard.runs.index',
        'durable_dashboard.runs.show',
        'durable_dashboard.runs.retry',
        'durable_dashboard.runs.cancel',
        'durable_dashboard.health',
        'durable_dashboard.compat',
      ]),
    );
  });
});
