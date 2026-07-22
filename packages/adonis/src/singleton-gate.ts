import type { SingletonConfig } from './engine.js';
import { SingletonQueueFullError } from './errors.js';
import type { StateStore, WorkflowRun } from './interfaces.js';

const SINGLETON_RETRY_MS = 1000;
/**
 * Max jitter (ms, each direction) added to {@link SINGLETON_RETRY_MS} so a queue of N gated runs
 * doesn't wake in lockstep and stampede the admission scan. Each retry picks an independent offset
 * in `[-SINGLETON_RETRY_JITTER_MS, +SINGLETON_RETRY_JITTER_MS]`.
 */
const SINGLETON_RETRY_JITTER_MS = 250;

export interface SingletonGateDeps {
  store: Pick<StateStore, 'listRuns' | 'updateRun'>;
  clock: () => number;
  /** Hand a gated run to the run dispatcher (fire-and-forget, like the engine's other dispatches). */
  dispatch: (runId: string) => void;
  /** Resolve a settled run's singleton config from the engine's workflow registry. */
  configFor: (run: WorkflowRun) => SingletonConfig | undefined;
}

/**
 * Per-key serialization for singleton workflows — start-time back-pressure, FIFO race-free
 * admission, and notify-on-release wakeups. Extracted from {@link WorkflowEngine} so the whole
 * singleton feature lives in one place instead of being smeared across `start`, `execute`, both run
 * loops, and `cancel`.
 */
export class SingletonGate {
  constructor(private readonly deps: SingletonGateDeps) {}

  /** The tag a singleton run carries, so the gate can find others sharing its key. */
  tag(cfg: SingletonConfig, input: unknown): string {
    return `singleton:${cfg.key(input)}`;
  }

  /** Next wake time for a gated run: the base retry delay jittered to avoid a wakeup stampede. */
  retryWakeAt(): number {
    return (
      this.deps.clock() +
      SINGLETON_RETRY_MS +
      Math.floor((Math.random() * 2 - 1) * SINGLETON_RETRY_JITTER_MS)
    );
  }

  /**
   * Reject a start that would grow the same-key backlog past `limit + maxQueueDepth` (counting
   * `pending`/`running`/`suspended` runs sharing the key in one scan). No-op when no `maxQueueDepth`
   * is configured.
   */
  async assertCapacity(workflow: string, cfg: SingletonConfig, input: unknown): Promise<void> {
    if (cfg.maxQueueDepth == null) return;
    const cap = (cfg.limit ?? 1) + cfg.maxQueueDepth;
    const queued = await this.deps.store.listRuns({
      tag: this.tag(cfg, input),
      workflow,
      statuses: ['pending', 'running', 'suspended'],
    });
    if (queued.length >= cap) {
      throw new SingletonQueueFullError(workflow, cfg.key(input), cfg.maxQueueDepth);
    }
  }

  /**
   * Whether `run` may run now under its key: it's among the `limit` oldest in-flight (running or
   * suspended) runs sharing the key, by `(createdAt, id)` order. A consistent store gives every
   * instance the same ordering, so admission is race-free + FIFO.
   */
  async admit(run: WorkflowRun, cfg: SingletonConfig): Promise<boolean> {
    // ONE scan for both in-flight statuses; the total `(createdAt, id)` sort makes admission order
    // independent of the store's row order, preserving the FIFO + race-free-across-instances contract.
    const inflight = (
      await this.deps.store.listRuns({
        tag: this.tag(cfg, run.input),
        workflow: run.workflow,
        statuses: ['running', 'suspended'],
      })
    ).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    const idx = inflight.findIndex((r) => r.id === run.id);
    return idx >= 0 && idx < (cfg.limit ?? 1);
  }

  /**
   * Notify-on-release: a singleton run settled (freeing a slot), so dispatch the oldest gated
   * (`suspended` + same tag) waiters now instead of waiting for their ~1s retry timer. Each re-checks
   * admission in the executor and runs only if it actually wins a slot, so FIFO/race-free guarantees
   * hold; the durable timer remains the cross-instance/crash fallback.
   */
  async wakeNext(settled: WorkflowRun): Promise<void> {
    const cfg = this.deps.configFor(settled);
    if (!cfg) return;
    const tag = settled.tags?.find((t) => t.startsWith('singleton:'));
    if (!tag) return;
    const gated = (
      await this.deps.store.listRuns({ tag, workflow: settled.workflow, statuses: ['suspended'] })
    ).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    for (const next of gated.slice(0, cfg.limit ?? 1)) {
      // Make the run due NOW rather than clearing its retry timer. The dispatch below goes through
      // the configured runDispatcher, which may legitimately be a NO-OP (a poll-only deployment
      // where `durable:work` owns every pickup) — clearing `wakeAt` before a no-op dispatch left
      // the gated run `suspended` with NO wake time, unreachable by every poll path, forever
      // (observed in production). A due `wakeAt` keeps the timer poller as the guaranteed pickup;
      // a dispatch+timer double-drive is safe — the run lease admits one executor and the loser's
      // pickup is a cheap no-op.
      await this.deps.store
        .updateRun(next.id, { wakeAt: this.deps.clock(), updatedAt: new Date() })
        .catch(() => undefined);
      this.deps.dispatch(next.id);
    }
  }
}
