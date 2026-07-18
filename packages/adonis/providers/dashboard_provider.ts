import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService, HttpRouterService } from '@adonisjs/core/types';
import {
  type ResolvedDashboardAuth,
  SESSION_COOKIE_NAME,
  performLogin,
  readSession,
} from '../src/dashboard/auth.js';
import { type CompatSource, compat } from '../src/dashboard/compat.js';
import {
  type DurableDashboardConfig,
  type ResolvedDurableDashboardConfig,
  resolveConfig,
} from '../src/dashboard/define_config.js';
import { BlockedDiagnosticsRecorder } from '../src/dashboard/diagnostics-recorder.js';
import { dashboardEngineForRole } from '../src/dashboard/gateway-adapter.js';
import {
  type ApiRequest,
  type ApiResponse,
  type DashboardEngine,
  type Deps,
  cancelRun,
  getRun,
  health,
  listRuns,
  retryRun,
} from '../src/dashboard/handlers.js';
import { renderDashboard } from '../src/dashboard/html.js';
import { renderLoginPage } from '../src/dashboard/login_page.js';
import type { DurableConfig } from '../src/define_config.js';
import { WorkflowEngine } from '../src/index.js';

/**
 * Mounts the durable dashboard into an AdonisJS app: a JSON API over the
 * {@link WorkflowEngine}'s read surface, and a single self-contained HTML page
 * that consumes it. All routes sit behind the configurable `authorize` guard from
 * `config/durable_dashboard.ts`.
 *
 * Routes (relative to the configured `path`, default `/durable`):
 * - `GET  /`                  → the dashboard HTML
 * - `GET  /api/runs`          → list runs (status/workflow/tag filters, paged)
 * - `GET  /api/runs/:id`      → run detail (run + step timeline + children)
 * - `POST /api/runs/:id/retry`  → re-enqueue the run
 * - `POST /api/runs/:id/cancel` → cancel the run
 * - `GET  /api/health`        → worker-group health
 */
export default class DashboardProvider {
  constructor(protected app: ApplicationService) {}

  /** Warn once so a throwing `login` hook doesn't spam the logs on every failed attempt. */
  private warnedOnHookThrow = false;

  /**
   * Captures the engine's `capability.unavailable` / `protocol.incompatible` diagnostics events so the
   * `/compat` health panel can render each blocked run's structured delta + the live-fleet compat view
   * (design §7.6, §10). Store-role only — attached in {@link boot}; a `tenant` pod owns no engine.
   */
  private readonly diagnostics = new BlockedDiagnosticsRecorder();
  /** Detach handle for the diagnostics subscription, released on {@link shutdown}. */
  private detachDiagnostics: (() => void) | null = null;

  /** The active durable role (`standalone` when no `durable` config is present — today's default). */
  private durableRole(): 'standalone' | 'control-plane' | 'tenant' {
    return this.app.config.get<DurableConfig>('durable', {}).role ?? 'standalone';
  }

  async boot() {
    const config = resolveConfig(
      this.app.config.get<DurableDashboardConfig>('durable_dashboard', {}),
    );
    if (!config.enabled) return;

    const role = this.durableRole();

    // Route registration can't happen synchronously in `boot()`: at this point in the AdonisJS
    // lifecycle the HTTP server/router binding may not be resolvable yet (bindings from other
    // providers' `boot()` methods can still be pending), and — critically — the *documented*
    // `@adonisjs/core/services/router` singleton is only assigned once the app's "booted" hooks run
    // (`await app.booted(async () => { router = ... })` inside that service module itself), which
    // fire strictly AFTER every provider's own `boot()`. A provider that imports that singleton and
    // calls `router.get(...)` directly inside `boot()` crashes every entrypoint (serve/ace/tests)
    // that registers it, because `router` is still `undefined` at that point.
    //
    // Deferring to `app.booted(...)` runs our route registration as another "booted" hook — the
    // same mechanism the router service uses to become available in the first place — which is
    // guaranteed to fire BEFORE `app.start()`'s callback boots the HTTP server and commits the
    // router (the last point at which routes can still be added). Resolving `router` fresh from the
    // container here (rather than depending on that service singleton) is also the same pattern
    // `@adonisjs/core`'s own `AppServiceProvider` uses internally.
    await this.app.booted(async () => {
      const router = await this.app.container.make('router');
      this.registerRoutes(router, config, role);
      await this.attachDiagnostics(role);
    });
  }

  /**
   * Subscribe the {@link diagnostics} recorder to the store-backed engine's lifecycle events so the
   * `/compat` panel is fed live (design §10). Store-role only: a `tenant` pod owns no engine (structural
   * isolation), so its panel shows blocked runs reason-only. Defensive: if the engine can't be resolved
   * (the dashboard mounted without `@adonis-agora/durable`'s provider), the recorder simply stays empty
   * rather than crashing boot.
   */
  private async attachDiagnostics(role: 'standalone' | 'control-plane' | 'tenant'): Promise<void> {
    if (role === 'tenant') return;
    try {
      const engine = await this.app.container.make(WorkflowEngine);
      this.detachDiagnostics = this.diagnostics.attach(engine);
    } catch {
      // No store-backed engine available — the compat panel degrades to reason-only blocked runs.
    }
  }

  private registerRoutes(
    router: HttpRouterService,
    config: ResolvedDurableDashboardConfig,
    role: 'standalone' | 'control-plane' | 'tenant',
  ): void {
    const apiBase = `${config.path}/api`;

    // Resolve the dashboard's read/control port lazily per request, branched by role (design §5/§8):
    // a store role resolves the engine (built by @adonis-agora/durable's provider); a store-less `tenant`
    // pod resolves the DURABLE_RUN_GATEWAY token (a ProxyRunGateway) and adapts it — NO engine, NO store.
    const resolveEngine = (): Promise<DashboardEngine> =>
      dashboardEngineForRole(role, this.app.container, WorkflowEngine);
    const deps = async (): Promise<Deps> => ({ engine: await resolveEngine() });

    // Built-in `dashboardAuth` login screen (opt-in). Registered ONLY when configured, so omitting
    // `dashboardAuth` leaves route registration byte-for-byte as it was. These endpoints are public
    // (behind NEITHER guard): they MINT the session the guard checks for, and the login page must
    // stay reachable while unauthenticated — including in production, where the default `authorize`
    // hook would otherwise deny it.
    if (config.dashboardAuth) {
      this.registerAuthRoutes(router, config, config.dashboardAuth);
    }

    // The HTML page.
    router
      .get(config.path === '' ? '/' : config.path, async (ctx) => {
        if (!(await this.enforce(config, ctx, 'page'))) return;
        ctx.response.header('content-type', 'text/html; charset=utf-8');
        return ctx.response.send(renderDashboard(apiBase));
      })
      .as('durable_dashboard.index');

    // JSON API.
    const json = (handler: (d: Deps, req: ApiRequest) => Promise<ApiResponse>) => {
      return async (ctx: HttpContext) => {
        if (!(await this.enforce(config, ctx, 'api'))) return;
        try {
          const result = await handler(await deps(), toApiRequest(ctx));
          return ctx.response.status(result.status).json(result.body);
        } catch (error) {
          return ctx.response
            .status(500)
            .json({ error: error instanceof Error ? error.message : 'internal error' });
        }
      };
    };

    router.get(`${apiBase}/runs`, json(listRuns)).as('durable_dashboard.runs.index');
    router.get(`${apiBase}/runs/:id`, json(getRun)).as('durable_dashboard.runs.show');
    router.post(`${apiBase}/runs/:id/retry`, json(retryRun)).as('durable_dashboard.runs.retry');
    router.post(`${apiBase}/runs/:id/cancel`, json(cancelRun)).as('durable_dashboard.runs.cancel');
    router
      .get(
        `${apiBase}/health`,
        json((d) => health(d)),
      )
      .as('durable_dashboard.health');

    // Fleet health / protocol-compatibility panel (design §7.6, §10): per queue/group/pod protocol +
    // negotiated level + red-flag reason on incompatibility, plus blocked runs with their structured delta.
    router
      .get(`${apiBase}/compat`, async (ctx: HttpContext) => {
        if (!(await this.enforce(config, ctx, 'api'))) return;
        try {
          const result = await compat(this.compatSource(await resolveEngine()));
          return ctx.response.status(result.status).json(result.body);
        } catch (error) {
          return ctx.response
            .status(500)
            .json({ error: error instanceof Error ? error.message : 'internal error' });
        }
      })
      .as('durable_dashboard.compat');
  }

  /** Assemble the {@link CompatSource} the `/compat` handler reads: the live-fleet compat view + captured
   *  diagnostics come from the {@link diagnostics} recorder (store role); blocked runs come from the
   *  role's own read port (so a `tenant` pod round-trips `listRuns({ statuses: ['blocked'] })`). */
  private compatSource(engine: DashboardEngine): CompatSource {
    return {
      controlPlaneDescriptor: () => this.diagnostics.controlPlaneDescriptor(),
      fleet: () => this.diagnostics.fleet(),
      blockedRuns: () => engine.listRuns({ statuses: ['blocked'] }),
      diagnosticsFor: (runId) => this.diagnostics.diagnosticsFor(runId),
    };
  }

  /**
   * Mount the built-in `dashboardAuth` endpoints under `basePath`. All three are public (no guard):
   * they create/destroy the session the {@link enforce} guard checks for.
   *
   * - `GET  <base>/login`  → the server-rendered login page (never varies per request beyond the
   *    developer-controlled `basePath`; `returnTo`/`error` are read client-side from the query).
   * - `POST <base>/login`  → verifies credentials via the host `login` hook and mints the cookie.
   *    Called by the login page's own `fetch` (JSON body). Uniform `401` on ANY failure — unknown
   *    user, wrong password, or a throwing hook — so there is no user-enumeration.
   * - `GET  <base>/logout` → clears the cookie and redirects back to the login page. A plain `GET`
   *    (idempotent, only ever destroys the caller's own session) so a simple `<a href>` works.
   */
  private registerAuthRoutes(
    router: HttpRouterService,
    config: ResolvedDurableDashboardConfig,
    auth: ResolvedDashboardAuth,
  ): void {
    const loginPath = `${config.path}/login`;
    const logoutPath = `${config.path}/logout`;

    router
      .get(loginPath, async (ctx) => {
        ctx.response.header('content-type', 'text/html; charset=utf-8');
        ctx.response.header('cache-control', 'no-store, must-revalidate');
        return ctx.response.send(renderLoginPage(config.path));
      })
      .as('durable_dashboard.login.page');

    router
      .post(loginPath, async (ctx) => {
        const outcome = await performLogin(auth, ctx.request.body(), config.path);
        if (outcome.kind === 'bad-request') {
          return ctx.response.status(400).json({ error: outcome.message });
        }
        if (outcome.kind === 'unauthorized') {
          // A throwing hook is a denial (never a 500), warn-logged once so a buggy hook doesn't
          // flood the logs. The client sees the same uniform 401 either way.
          if (outcome.hookError !== undefined && !this.warnedOnHookThrow) {
            this.warnedOnHookThrow = true;
            const message =
              outcome.hookError instanceof Error
                ? outcome.hookError.message
                : String(outcome.hookError);
            const logger = await this.app.container.make('logger');
            logger.warn(`dashboardAuth login hook threw; treating as denial. ${message}`);
          }
          return ctx.response.status(401).json({ error: outcome.message });
        }
        this.writeSessionCookie(ctx, auth, outcome.cookieValue);
        return ctx.response.status(200).json({ redirectTo: outcome.redirectTo });
      })
      .as('durable_dashboard.login.submit');

    router
      .get(logoutPath, async (ctx) => {
        ctx.response.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
        return ctx.response.redirect().toPath(loginPath);
      })
      .as('durable_dashboard.logout');
  }

  /**
   * Run the guards for a dashboard resource. Composes the existing `authorize` hook (bearer
   * token/custom) with the optional `dashboardAuth` session guard — BOTH must pass:
   *
   * 1. `authorize` fails → `403` (unchanged behavior).
   * 2. `dashboardAuth` configured AND no valid session → for a `page` request, redirect `302` to
   *    the login page carrying a sanitized `returnTo`; for an `api` request, a plain `401`.
   *
   * When `dashboardAuth` is unconfigured only step 1 runs, so behavior is byte-for-byte unchanged.
   * Returns `false` (and has already written the response) when the request must short-circuit.
   */
  private async enforce(
    config: ResolvedDurableDashboardConfig,
    ctx: HttpContext,
    mode: 'page' | 'api',
  ): Promise<boolean> {
    const allowed = await config.authorize(ctx);
    if (!allowed) {
      ctx.response.status(403).json({ error: 'forbidden' });
      return false;
    }

    const auth = config.dashboardAuth;
    if (!auth) return true;

    const session = readSession(auth, this.readSessionCookie(ctx));
    if (session) return true;

    if (mode === 'page') {
      const returnTo = ctx.request.url(true);
      ctx.response.redirect().withQs('returnTo', returnTo).toPath(`${config.path}/login`);
      return false;
    }
    ctx.response.status(401).json({ error: 'unauthorized' });
    return false;
  }

  /** Read the raw (unencoded) session cookie value, or `undefined` when absent. */
  private readSessionCookie(ctx: HttpContext): string | undefined {
    const value = ctx.request.plainCookie(SESSION_COOKIE_NAME, undefined, false);
    return typeof value === 'string' && value !== '' ? value : undefined;
  }

  /**
   * Write the signed session as an unsigned (`plainCookie`, `encode: false`) cookie — the value
   * carries its own HMAC signature, so AdonisJS's cookie signing would be redundant double-wrapping.
   * `HttpOnly` + `SameSite=Lax` (blocks cross-site POSTs carrying the cookie — CSRF coverage) +
   * `Secure` on https. `Path=/` so it reaches both the UI and API mounts regardless of prefix.
   */
  private writeSessionCookie(ctx: HttpContext, auth: ResolvedDashboardAuth, value: string): void {
    ctx.response.plainCookie(SESSION_COOKIE_NAME, value, {
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.request.secure(),
      path: '/',
      maxAge: Math.floor(auth.ttlMs / 1000),
      encode: false,
    });
  }

  /** Detach the diagnostics subscription so the recorder stops listening on a clean shutdown/redeploy. */
  async shutdown(): Promise<void> {
    this.detachDiagnostics?.();
    this.detachDiagnostics = null;
  }
}

/** Adapt an AdonisJS `HttpContext` to the framework-light {@link ApiRequest}. */
function toApiRequest(ctx: HttpContext): ApiRequest {
  return {
    params: ctx.params as Record<string, string | undefined>,
    query: ctx.request.qs() as Record<string, string | string[] | undefined>,
    body: ctx.request.body(),
  };
}
