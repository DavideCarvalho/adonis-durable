import type { ApplicationService } from '@adonisjs/core/types';
import { describe, expect, it, vi } from 'vitest';

/**
 * `booted_app` keeps module-level singleton state (the captured app + its promise), so each test loads
 * a FRESH copy via `vi.resetModules()` + dynamic import to isolate the register/timeout state.
 */
async function freshModule(): Promise<typeof import('../../src/services/booted_app.js')> {
  vi.resetModules();
  return import('../../src/services/booted_app.js');
}

const fakeApp = {} as ApplicationService;

describe('whenBootedApp timeout', () => {
  it('rejects with an actionable message when DurableProvider never registers', async () => {
    const { whenBootedApp } = await freshModule();
    // Short timeout so the suite stays fast; without a register the promise would otherwise hang forever.
    await expect(whenBootedApp(20)).rejects.toThrow(/did not register within 20ms/);
    await expect(whenBootedApp(20)).rejects.toThrow(/adonisrc\.ts providers/);
  });

  it('resolves immediately via the fast path once the provider has registered (no timer armed)', async () => {
    const { setBootedApp, whenBootedApp } = await freshModule();
    setBootedApp(fakeApp);
    // Even a 0ms timeout can't fire: the already-registered app takes the synchronous fast path.
    await expect(whenBootedApp(0)).resolves.toBe(fakeApp);
  });

  it('resolves (never rejects) when the provider registers before the timeout elapses', async () => {
    const { setBootedApp, whenBootedApp } = await freshModule();
    const pending = whenBootedApp(1_000);
    setBootedApp(fakeApp);
    await expect(pending).resolves.toBe(fakeApp);
  });
});
