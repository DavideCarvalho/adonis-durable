/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.7.0';

export { defineConfig, defaultAuthorize, resolveConfig } from './define_config.js';
export type {
  AuthorizeHook,
  DurableDashboardConfig,
  ResolvedDurableDashboardConfig,
} from './define_config.js';
export {
  listRuns,
  getRun,
  retryRun,
  cancelRun,
  health,
} from './handlers.js';
export type { ApiRequest, ApiResponse, Deps } from './handlers.js';
export { renderDashboard } from './html.js';
