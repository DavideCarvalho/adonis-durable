import { createRequire } from 'node:module';
import type { WorkflowEngine } from './engine.js';

// Resolve the optional `cron-parser` peer dependency in a way that works in BOTH the ESM and CJS
// builds of this package (dual publish). `createRequire(import.meta.url)` gives a real `require` in
// ESM output; in the CJS build, tsup's banner shims `import.meta.url` to the file URL, so the same
// call resolves there too. This keeps the load synchronous (no async leak into the scheduler API).
const nodeRequire = createRequire(import.meta.url);

export interface ScheduledWorkflow {
  /** Stable key identifying this schedule — part of the deterministic run id. */
  key: string;
  workflow: string;
  input?: unknown;
  /** Start one run every `everyMs`. Mutually exclusive with `cron`. */
  everyMs?: number;
  /**
   * A cron expression (5 fields `m h dom mon dow`, or 6 with leading seconds) evaluated in
   * {@link ScheduledWorkflow.timezone}. Mutually exclusive with `everyMs`. Needs the optional peer
   * dependency `cron-parser`.
   */
  cron?: string;
  /** IANA timezone the `cron` fires in (e.g. `America/Sao_Paulo`). Defaults to UTC. */
  timezone?: string;
  /** Temporarily stop firing this schedule (kept registered). Defaults to false. */
  paused?: boolean;
  /**
   * What to do when the previous window's run hasn't finished yet (fixed-interval schedules only):
   * `'allow'` (default) starts the new window anyway; `'skip'` skips it while the prior run is still
   * `running`/`suspended`, so a slow run can't pile up overlapping executions.
   */
  overlap?: 'allow' | 'skip';
  /**
   * Randomly delay the dispatch by up to this many ms BEFORE firing, to spread load when many
   * instances tick on the same boundary (avoids a thundering herd). Opt-in; absent = fire immediately.
   *
   * This is dispatch-path jitter only — it does NOT affect the run id (still the time bucket), so
   * idempotency is unchanged: two instances jittering the same window still start it exactly once.
   * (The engine forbids `Math.random` inside workflow code; the scheduler dispatch path is not
   * workflow code, so jitter here is fine.)
   */
  jitter?: number;
  /**
   * Enqueue windows that were missed while the scheduler was down, instead of silently skipping
   * them. Opt-in; absent = only the current window fires. `maxCatchup` bounds how many PRIOR windows
   * are backfilled (a long outage can't flood the system). Backfilled runs use each missed window's
   * deterministic bucket run id, so `engine.start` idempotency skips any that already ran.
   */
  backfill?: { maxCatchup: number };
}

/** Injectable dispatch-path effects (kept out of the deterministic run-id logic). Defaults to real
 *  `Math.random` + `setTimeout`; overridden in tests so jitter is deterministic and instant. */
export interface RunSchedulesOptions {
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Deterministic run id for a fixed-interval schedule's current time window. */
export function scheduledRunId(key: string, everyMs: number, nowMs: number): string {
  return `sched:${key}:${Math.floor(nowMs / everyMs)}`;
}

type CronParser = typeof import('cron-parser');
let cronParser: CronParser | undefined;
function loadCronParser(): CronParser {
  if (cronParser) return cronParser;
  try {
    // Lazy + optional: core stays dependency-free; only users who schedule by cron need this.
    cronParser = nodeRequire('cron-parser') as CronParser;
  } catch {
    throw new Error(
      'cron schedules need the optional peer dependency "cron-parser" — install it (e.g. `npm i cron-parser`).',
    );
  }
  return cronParser;
}

/**
 * Epoch ms of the most recent cron fire at or before `nowMs`, evaluated in `timezone` (default UTC).
 * This is the deterministic "bucket" a cron run is keyed on, so polling repeatedly within an
 * interval resolves to the same fire time — and thus the same idempotent run id.
 */
export function prevCronFireMs(expr: string, nowMs: number, timezone = 'UTC'): number {
  const parser = loadCronParser();
  // `+1` makes a fire landing exactly on `nowMs` count as "at or before now", not the prior one.
  const it = parser.parseExpression(expr, { currentDate: new Date(nowMs + 1), tz: timezone });
  return it.prev().toDate().getTime();
}

/** The deterministic, idempotent run id for a schedule at `nowMs` — its current fire window. */
function scheduleRunIdAt(s: ScheduledWorkflow, nowMs: number): string {
  if (s.cron != null) return `sched:${s.key}:${prevCronFireMs(s.cron, nowMs, s.timezone)}`;
  if (s.everyMs != null) return scheduledRunId(s.key, s.everyMs, nowMs);
  throw new Error(`schedule "${s.key}" needs either "everyMs" or "cron"`);
}

/**
 * The run ids this schedule should fire at `nowMs`: the current window, plus — when `backfill` is set
 * — up to `maxCatchup` prior windows that may have been missed. Oldest-first, so a backfill catches
 * up in chronological order. Ids are the same deterministic buckets `scheduleRunIdAt` produces, so
 * `engine.start` idempotency drops any window that already ran.
 */
function scheduleRunIdsAt(s: ScheduledWorkflow, nowMs: number): string[] {
  const current = scheduleRunIdAt(s, nowMs);
  if (!s.backfill || s.backfill.maxCatchup <= 0) return [current];

  const ids: string[] = [];
  if (s.everyMs != null) {
    const bucket = Math.floor(nowMs / s.everyMs);
    const oldest = Math.max(0, bucket - s.backfill.maxCatchup);
    for (let b = oldest; b < bucket; b += 1) ids.push(`sched:${s.key}:${b}`);
  } else if (s.cron != null) {
    // Walk back through prior cron fire times (most-recent missed first), then reverse to oldest-first.
    const prior: string[] = [];
    let cursor = prevCronFireMs(s.cron, nowMs, s.timezone);
    for (let i = 0; i < s.backfill.maxCatchup; i += 1) {
      // `cursor` (exclusive) → the fire strictly before it.
      const before = prevCronFireMs(s.cron, cursor - 1, s.timezone);
      prior.push(`sched:${s.key}:${before}`);
      cursor = before;
    }
    ids.push(...prior.reverse());
  }
  ids.push(current);
  return ids;
}

/**
 * Start each schedule's current-window run. The run id is the time bucket (a fixed-interval index,
 * or the cron fire time) and `engine.start` is idempotent, so firing this on an interval — or
 * racing two instances on the same tick — starts **each window exactly once**. Wire it to a
 * `setInterval`, the durable timer poller, or `@nestjs/schedule`. Returns the run ids for the
 * current windows.
 */
export async function runSchedules(
  engine: Pick<WorkflowEngine, 'start' | 'getRun'>,
  schedules: readonly ScheduledWorkflow[],
  nowMs: number,
  opts?: RunSchedulesOptions,
): Promise<string[]> {
  const random = opts?.random ?? Math.random;
  const sleep = opts?.sleep ?? defaultSleep;
  const ids: string[] = [];
  for (const s of schedules) {
    if (s.paused) continue;
    // overlap:'skip' (fixed-interval): don't start this window while the previous window's run is
    // still in-flight, so a slow run can't pile up. Interval-only — cron windows aren't adjacent ids.
    if (s.overlap === 'skip' && s.everyMs) {
      const prevBucket = Math.floor(nowMs / s.everyMs) - 1;
      if (prevBucket >= 0) {
        const prev = await engine.getRun(`sched:${s.key}:${prevBucket}`);
        if (prev && (prev.status === 'running' || prev.status === 'suspended')) continue;
      }
    }
    // Dispatch-path jitter (not workflow code): spread same-boundary ticks across instances. Applied
    // once per schedule, before firing — the run ids below are unaffected, so idempotency holds.
    if (s.jitter && s.jitter > 0) await sleep(Math.floor(random() * s.jitter));
    for (const runId of scheduleRunIdsAt(s, nowMs)) {
      await engine.start(s.workflow, s.input, runId);
      ids.push(runId);
    }
  }
  return ids;
}
