import type { ApplicationService } from '@adonisjs/core/types';

/**
 * The booted {@link ApplicationService}, captured by `DurableProvider.register()` — which the
 * application instantiates with its OWN booted app instance.
 *
 * Why capture it here instead of `import app from '@adonisjs/core/services/app'`: in a pnpm
 * (workspace / hoisted) install this package can resolve a DIFFERENT physical copy of
 * `@adonisjs/core` than the one `bin/server` booted. `services/app` exposes the app through a
 * module-level binding set at boot (`setApp`), so a non-booted copy's binding stays `undefined` —
 * importing it there yields an undefined app (`Cannot read properties of undefined (reading 'booted')`).
 * This is the same dual-package hazard that (with `@adonisjs/lucid`) has already broken production
 * here. The instance the provider RECEIVES is always the booted one, so reading it here is immune to
 * a core copy / peer-variant split. Mirrors `@adonis-agora/authz`'s `booted_app`.
 */
let bootedApp: ApplicationService | undefined;
let resolveBootedApp: (app: ApplicationService) => void;
const bootedAppPromise = new Promise<ApplicationService>((resolve) => {
  resolveBootedApp = resolve;
});

/** Record the booted app. Called once by {@link DurableProvider} during `register()`. */
export function setBootedApp(app: ApplicationService): void {
  if (bootedApp) return;
  bootedApp = app;
  resolveBootedApp(app);
}

/** Default window `whenBootedApp` waits for `DurableProvider.register()` before rejecting. */
const DEFAULT_BOOTED_APP_TIMEOUT_MS = 5_000;

/**
 * Resolves with the provider-captured booted app. `services/main` awaits this (instead of importing
 * `@adonisjs/core/services/app`) before reading the container, so its eager top-level population is
 * driven by the SAME app copy `bin/server` booted — see the module doc above for the pnpm hazard.
 *
 * If the {@link DurableProvider} never registers, the underlying promise would otherwise stay pending
 * FOREVER — a silent top-level-await hang in `services/main` that's worse DX than a clear failure. So
 * this rejects after `timeoutMs` (default 5s) with an actionable message. The normal path is
 * unaffected: the provider registers during boot before this is awaited, so the fast path returns an
 * already-resolved promise (no timer armed); and even when a timer is armed it's cleared — and
 * `unref`'d so it never keeps the process alive — the moment the app arrives.
 */
export function whenBootedApp(
  timeoutMs: number = DEFAULT_BOOTED_APP_TIMEOUT_MS,
): Promise<ApplicationService> {
  // Fast path: the provider already registered — resolve immediately, arm no timer.
  if (bootedApp) return Promise.resolve(bootedApp);
  return new Promise<ApplicationService>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `@adonis-agora/durable: DurableProvider did not register within ${timeoutMs}ms. Add "@adonis-agora/durable/durable_provider" to your adonisrc.ts providers.`,
        ),
      );
    }, timeoutMs);
    // Don't let the timeout keep the process alive on an otherwise-idle boot.
    (timer as { unref?: () => void }).unref?.();
    // `bootedAppPromise` only ever resolves (via `setBootedApp`), never rejects.
    void bootedAppPromise.then((app) => {
      clearTimeout(timer);
      resolve(app);
    });
  });
}

/**
 * The booted app, synchronously — throws if read before the provider registered. A clear signal that
 * `@adonis-agora/durable/durable_provider` is missing from the app's providers.
 */
export function getBootedApp(): ApplicationService {
  if (!bootedApp) {
    throw new Error(
      '@adonis-agora/durable: app accessed before DurableProvider registered. Add "@adonis-agora/durable/durable_provider" to your adonisrc.ts providers.',
    );
  }
  return bootedApp;
}
