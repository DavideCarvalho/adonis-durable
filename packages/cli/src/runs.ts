import type {
  RunQuery,
  RunResult,
  RunStatus,
  WorkflowEngine,
  WorkflowRun,
} from '@agora/durable-core';

export interface ListRunsOptions {
  /** Filter by run status (pending | running | suspended | completed | failed | cancelled | dead). */
  status?: RunStatus | undefined;
  /** Filter by workflow name. */
  workflow?: string | undefined;
  /** Max rows. Default 50. */
  limit?: number | undefined;
}

/** Anything that can list runs — both a {@link WorkflowEngine} and a raw `StateStore` satisfy it. */
export interface RunLister {
  listRuns(query: RunQuery): Promise<WorkflowRun[]>;
}

/** Query recent runs, newest activity first (the source returns its own order). */
export async function listRuns(source: RunLister, opts: ListRunsOptions): Promise<WorkflowRun[]> {
  return source.listRuns({
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.workflow ? { workflow: opts.workflow } : {}),
    limit: opts.limit ?? 50,
  });
}

/** Render a runs list as a plain-text table for the terminal. */
export function renderRunsTable(runs: WorkflowRun[]): string {
  if (runs.length === 0) return 'No runs.';
  const rows = runs.map((r) => [r.id, r.workflow, r.status, relTime(r.updatedAt)]);
  return table(['RUN', 'WORKFLOW', 'STATUS', 'UPDATED'], rows);
}

/**
 * Retry a run: re-enqueue it for a worker to (re-)execute via the engine's `requeue` (the
 * dispatch-model retry — sets it back to `pending`, clears any stale lease, replays its checkpoints).
 * Returns the enqueued result, or null if the run is unknown.
 */
export async function retryRun(engine: WorkflowEngine, runId: string): Promise<RunResult | null> {
  return engine.requeue(runId);
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  return [fmt(headers), ...rows.map(fmt)].join('\n');
}

function relTime(date: Date): string {
  const s = Math.round((Date.now() - date.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}
