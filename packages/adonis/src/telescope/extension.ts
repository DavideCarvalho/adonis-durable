import { type DurableDashboardOptions, durableDashboard } from './dashboard.js';
import {
  durableDurationProvider,
  durableRecentFailuresProvider,
  durableRunsOverTimeProvider,
  durableStateBreakdownProvider,
  durableStateProvider,
  durableSuccessRateProvider,
  durableThroughputProvider,
  durableTimeseriesProvider,
  durableWorkerHealthProvider,
} from './data-providers.js';
import type { TelescopeExtension } from './telescope-sdk.js';

/**
 * The first-class `@agora/telescope` extension for `@agora/durable`: a "Workflows" health dashboard
 * (golden signals) plus the data providers it binds to. Wire it into `config/telescope.ts`:
 *
 * ```ts
 * import { defineConfig } from '@agora/telescope'
 * import { durableTelescopeExtension } from '@agora/durable/telescope'
 *
 * export default defineConfig({ extensions: [durableTelescopeExtension()] })
 * ```
 *
 * No watcher is contributed — the `@agora/durable` provider already bridges engine events onto the
 * diagnostics bus, and Telescope's generic diagnostics watcher records them; the entry-backed
 * providers read those `tag: 'lib:durable'` entries, the rest query the live engine.
 *
 * The returned object structurally satisfies `@agora/telescope`'s `TelescopeExtension` (it is not
 * imported — see `telescope-sdk.ts` for why).
 */
export function durableTelescopeExtension(opts: DurableDashboardOptions = {}): TelescopeExtension {
  return {
    name: 'durable',
    dashboards: () => [durableDashboard(opts)],
    dataProviders: () => [
      durableStateProvider(),
      durableTimeseriesProvider(),
      durableRecentFailuresProvider(),
      durableWorkerHealthProvider(),
      durableDurationProvider(),
      durableRunsOverTimeProvider(),
      durableSuccessRateProvider(),
      durableThroughputProvider(),
      durableStateBreakdownProvider(),
    ],
  };
}
