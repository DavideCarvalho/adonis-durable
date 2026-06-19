import type { StateStore } from '@agora/durable-core';

/**
 * The slice of the AdonisJS application the CLI needs: its config bag. Read structurally so the CLI
 * package has no hard dependency on `@adonisjs/core` types beyond the peer.
 */
interface AppLike {
  config: { get<T>(key: string, defaultValue?: T): T };
}

/**
 * Resolve the configured {@link StateStore} for the runs-listing commands. The `@agora/durable`
 * provider builds the engine's store from `config/durable.ts`'s `store`; the engine keeps it private,
 * so the `durable:runs` command reads the same configured store directly to run list queries.
 *
 * Returns `undefined` when no store is configured (the in-process default the provider falls back to
 * is not surfaced in config) — the command reports that listing needs a configured store.
 */
export function resolveStore(app: AppLike): StateStore | undefined {
  const config = app.config.get<{ store?: unknown }>('durable', {});
  const store = config.store;
  return isStateStore(store) ? store : undefined;
}

function isStateStore(value: unknown): value is StateStore {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StateStore).listRuns === 'function'
  );
}
