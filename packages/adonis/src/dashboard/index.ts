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

// Built-in `dashboardAuth` login screen (optional; opt-in via `config/durable_dashboard.ts`).
export {
  resolveDashboardAuth,
  performLogin,
  readSession,
  sanitizeReturnTo,
  SESSION_COOKIE_NAME,
} from './auth.js';
export type {
  DashboardAuthOptions,
  ResolvedDashboardAuth,
  LoginHook,
  LoginOutcome,
} from './auth.js';
export {
  signSessionCookie,
  verifySessionCookie,
} from './session_cookie.js';
export type {
  DashboardSession,
  DashboardSessionUser,
  SignOptions,
  VerifyOptions,
} from './session_cookie.js';
export { renderLoginPage } from './login_page.js';
