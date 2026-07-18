import type {
  GroupHealth,
  RunQuery,
  RunResult,
  RunStatus,
  StepCheckpoint,
  WorkflowRun,
} from '../index.js';

/**
 * Framework-light JSON handlers over a {@link DashboardEngine}.
 *
 * Each handler takes a {@link Deps} bundle (just the read/control port — runs
 * and checkpoints are read through its own read API, {@link
 * DashboardEngine.listRuns} / {@link DashboardEngine.listCheckpoints}, so the
 * dashboard never reaches for a private store) plus a plain {@link
 * ApiRequest} (a thin view of the parts of an HTTP request it needs), and
 * returns a plain {@link ApiResponse} (status + JSON body). No AdonisJS types
 * leak in, so the handlers are unit-testable against a real in-memory engine
 * with no HTTP server. The provider adapts an AdonisJS `HttpContext` to these
 * shapes.
 */

/**
 * The bounded read/control surface the JSON handlers drive — declared STRUCTURALLY (a port), not by
 * importing the concrete `WorkflowEngine` class, so the same handlers serve BOTH durable topologies
 * (design §8): a store role passes the real {@link import('../engine.js').WorkflowEngine} (structurally
 * assignable — it has every method here); a store-less `tenant` pod passes an adapter over its
 * {@link import('../run-gateway/interface.js').RunGateway} (see `gatewayDashboardEngine`). Store presence
 * is therefore invisible to the handlers. Mirrors the `RunGatewayEngine` port pattern already used by
 * `StoreRunGateway`.
 */
export interface DashboardEngine {
  getRun(runId: string): Promise<WorkflowRun | null>;
  listRuns(query: RunQuery): Promise<WorkflowRun[]>;
  listCheckpoints(runId: string): Promise<StepCheckpoint[]>;
  getRunChildren(runId: string): Promise<string[]>;
  requeue(runId: string): Promise<RunResult | null>;
  cancel(runId: string, opts?: { compensate?: boolean }): Promise<RunResult | null>;
  workerHealth(extra?: string[]): Promise<GroupHealth[]>;
}

/** The read/control port the handlers operate over (a store engine or a tenant gateway adapter). */
export interface Deps {
  engine: DashboardEngine;
}

/** The subset of an HTTP request the handlers read. */
export interface ApiRequest {
  /** Route params, e.g. `{ id: 'run-1' }`. */
  params: Record<string, string | undefined>;
  /** Parsed query string, e.g. `{ status: 'failed', limit: '20' }`. */
  query: Record<string, string | string[] | undefined>;
  /** Parsed JSON body (for POST actions). */
  body?: unknown;
}

/** A plain JSON response: an HTTP status and a serializable body. */
export interface ApiResponse {
  status: number;
  body: unknown;
}

/** A `200 OK` JSON response. Exported so sibling handlers (e.g. `compat`) share one convention. */
export const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const notFound = (message: string): ApiResponse => ({
  status: 404,
  body: { error: message },
});

const RUN_STATUSES: readonly RunStatus[] = [
  'pending',
  'running',
  'suspended',
  'completed',
  'failed',
  'cancelled',
  'dead',
];

function firstQuery(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Parse a positive integer query param, falling back to `fallback` when absent/invalid. */
function intQuery(value: string | string[] | undefined, fallback: number): number {
  const raw = firstQuery(value);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Validate that a string is a known {@link RunStatus}, else `undefined`. */
function parseStatus(value: string | undefined): RunStatus | undefined {
  if (value && (RUN_STATUSES as readonly string[]).includes(value)) {
    return value as RunStatus;
  }
  return undefined;
}

/** `GET /runs` — list runs filtered by status/workflow/tag, paginated. */
export async function listRuns(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const { engine } = deps;
  const limit = Math.min(intQuery(req.query.limit, 50), 200);
  const offset = intQuery(req.query.offset, 0);
  const status = parseStatus(firstQuery(req.query.status));
  const workflow = firstQuery(req.query.workflow);
  const tag = firstQuery(req.query.tag);

  // Build the query with only the predicates that are set — exactOptionalPropertyTypes
  // forbids passing an explicit `undefined`.
  const query: RunQuery = { limit, offset };
  if (status) query.status = status;
  if (workflow) query.workflow = workflow;
  if (tag) query.tag = tag;

  const runs = await engine.listRuns(query);
  return ok({
    runs: runs.map(summarizeRun),
    page: { limit, offset, count: runs.length },
    statuses: RUN_STATUSES,
  });
}

/** `GET /runs/:id` — a run's detail: the run, its step timeline, and child run ids. */
export async function getRun(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const { engine } = deps;
  const id = req.params.id;
  if (!id) return notFound('run id is required');
  const run = await engine.getRun(id);
  if (!run) return notFound(`run ${id} not found`);
  const [timeline, children] = await Promise.all([
    engine.listCheckpoints(id),
    engine.getRunChildren(id),
  ]);
  return ok({
    run: detailRun(run),
    timeline: timeline.map(summarizeCheckpoint),
    children,
  });
}

/**
 * `POST /runs/:id/retry` — re-enqueue a failed/incomplete run for a worker to
 * resume (completed steps replay from their checkpoints). Returns the enqueued
 * state immediately; never blocks on execution.
 */
export async function retryRun(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const id = req.params.id;
  if (!id) return notFound('run id is required');
  const result = await deps.engine.requeue(id);
  if (!result) return notFound(`run ${id} not found`);
  return ok({ result });
}

/**
 * `POST /runs/:id/redispatch` — re-enqueue every remote step of a run stuck `pending`, for a run
 * whose dispatched step job was LOST (worker crashed with no result, or the transport dropped the
 * job). The idempotent step re-runs and its result resumes the run. Returns the run's current status
 * and the count re-dispatched; never blocks on execution.
 */
export async function redispatchPendingRun(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const id = req.params.id;
  if (!id) return notFound('run id is required');
  const result = await deps.engine.redispatchPending(id);
  if (!result) return notFound(`run ${id} not found`);
  return ok({ result });
}

/** `POST /runs/:id/cancel` — cancel a run. Pass `{ compensate: true }` to undo the saga first. */
export async function cancelRun(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  const id = req.params.id;
  if (!id) return notFound('run id is required');
  const compensate =
    typeof req.body === 'object' &&
    req.body !== null &&
    (req.body as Record<string, unknown>).compensate === true;
  const result = await deps.engine.cancel(id, compensate ? { compensate: true } : undefined);
  if (!result) return notFound(`run ${id} not found`);
  return ok({ result });
}

/** `GET /health` — per-group worker health (queue backlog + live worker heartbeats). */
export async function health(deps: Deps): Promise<ApiResponse> {
  const groups: GroupHealth[] = await deps.engine.workerHealth();
  return ok({
    groups: groups.map((g) => ({
      group: g.group,
      depth: g.depth,
      liveWorkers: g.liveWorkers.length,
      // The actionable alert state: work piling up with no consumer.
      stalled: g.depth > 0 && g.liveWorkers.length === 0,
    })),
  });
}

/** Compact run shape for the list view. */
function summarizeRun(run: WorkflowRun) {
  return {
    id: run.id,
    workflow: run.workflow,
    workflowVersion: run.workflowVersion,
    status: run.status,
    tags: run.tags ?? [],
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

/** Fuller run shape for the detail view. */
function detailRun(run: WorkflowRun) {
  return {
    ...summarizeRun(run),
    input: run.input,
    output: run.output,
    error: run.error,
    searchAttributes: run.searchAttributes,
    wakeAt: run.wakeAt,
    recoveryAttempts: run.recoveryAttempts,
  };
}

/** Compact checkpoint shape for the timeline. */
function summarizeCheckpoint(cp: StepCheckpoint) {
  const durationMs = cp.finishedAt.getTime() - cp.startedAt.getTime();
  const queueMs = cp.startedAt.getTime() - cp.enqueuedAt.getTime();
  return {
    seq: cp.seq,
    name: cp.name,
    kind: cp.kind,
    status: cp.status,
    attempts: cp.attempts,
    workerGroup: cp.workerGroup,
    output: cp.output,
    error: cp.error,
    events: cp.events ?? [],
    enqueuedAt: cp.enqueuedAt.toISOString(),
    startedAt: cp.startedAt.toISOString(),
    finishedAt: cp.finishedAt.toISOString(),
    durationMs: durationMs >= 0 ? durationMs : 0,
    queueMs: queueMs >= 0 ? queueMs : 0,
  };
}
