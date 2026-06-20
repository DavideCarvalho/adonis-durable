import type { HttpContext } from '@adonisjs/core/http';
import router from '@adonisjs/core/services/router';
import type { ApplicationService } from '@adonisjs/core/types';
import { type StateStore, WorkflowEngine } from '@agora/durable-core';
import {
  type DurableDashboardConfig,
  type ResolvedDurableDashboardConfig,
  resolveConfig,
} from '../src/define_config.js';
import {
  type ApiRequest,
  type ApiResponse,
  type Deps,
  cancelRun,
  getRun,
  health,
  listRuns,
  retryRun,
} from '../src/handlers.js';
import { renderDashboard } from '../src/html.js';

/** The shape of `config/durable.ts` this provider reads the store off of. */
interface DurableConfigLike {
  store?: StateStore;
}

/**
 * Mounts the durable dashboard into an AdonisJS app: a JSON API over the
 * {@link WorkflowEngine} + its store, and a single self-contained HTML page that
 * consumes it. All routes sit behind the configurable `authorize` guard from
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

  async boot() {
    const config = resolveConfig(
      this.app.config.get<DurableDashboardConfig>('durable_dashboard', {}),
    );
    if (!config.enabled) return;

    this.registerRoutes(config);
  }

  private registerRoutes(config: ResolvedDurableDashboardConfig): void {
    const apiBase = `${config.path}/api`;

    // Resolve the engine + store lazily per request: the engine singleton is
    // built by @agora/durable's provider; the store is the same instance from
    // config/durable.ts (the engine keeps its own store private).
    const deps = async (): Promise<Deps> => {
      const engine = await this.app.container.make(WorkflowEngine);
      const durable = this.app.config.get<DurableConfigLike>('durable', {});
      // Without a configured store the engine defaults to its own in-memory one,
      // which the dashboard can't reach — surface that clearly instead of lying
      // with an empty list.
      if (!durable.store) {
        throw new Error(
          '[durable-dashboard] config/durable.ts has no `store` — set a StateStore so the dashboard can read runs (the engine keeps its store private).',
        );
      }
      return { engine, store: durable.store };
    };

    // The HTML page.
    router
      .get(config.path === '' ? '/' : config.path, async (ctx) => {
        if (!(await this.guard(config, ctx))) return;
        ctx.response.header('content-type', 'text/html; charset=utf-8');
        return ctx.response.send(renderDashboard(apiBase));
      })
      .as('durable_dashboard.index');

    // JSON API.
    const json = (handler: (d: Deps, req: ApiRequest) => Promise<ApiResponse>) => {
      return async (ctx: HttpContext) => {
        if (!(await this.guard(config, ctx))) return;
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
  }

  /**
   * Run the configured guard. On denial, replies `403` and returns `false` so
   * the route handler short-circuits.
   */
  private async guard(config: ResolvedDurableDashboardConfig, ctx: HttpContext): Promise<boolean> {
    const allowed = await config.authorize(ctx);
    if (!allowed) {
      ctx.response.status(403).json({ error: 'forbidden' });
      return false;
    }
    return true;
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
