import { AsyncLocalStorage } from 'node:async_hooks';
import type { WorkflowCtx } from './interfaces.js';

/**
 * Ambient, per-run-turn {@link WorkflowCtx}. The engine wraps each body turn (`fn(ctx, input)`, and
 * every replay of it) in `workflowAls.run(ctx, …)`, so any code reachable from the body — including a
 * `BaseWorkflow` static like `Inner.start(...)` — can read the *current* run's ctx without threading
 * it through every call. Node's ALS is await-safe, so the ambient ctx propagates across the body's
 * `await` chain for the whole turn and is re-established on each replay (correct: a replay is a fresh
 * turn with its own ctx). The explicit `ctx` param stays the guaranteed accessor; this is the
 * convenience the context-aware statics read.
 */
export const workflowAls = new AsyncLocalStorage<WorkflowCtx>();

/**
 * The {@link WorkflowCtx} of the workflow run currently executing on this async call stack, or
 * `undefined` when called outside any run (a controller, service, script, or job). `BaseWorkflow`'s
 * static `start`/`dispatch` read this to route: a defined ctx means "inside a running workflow" (go
 * through `ctx.child`/`ctx.startChild` to stay deterministic); `undefined` means "outside" (go
 * through the engine). Must be read within the run's synchronous await flow — the normal case.
 */
export function getCurrentWorkflowCtx(): WorkflowCtx | undefined {
  return workflowAls.getStore();
}
