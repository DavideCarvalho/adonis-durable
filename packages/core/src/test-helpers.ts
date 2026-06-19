import type { StartOptions, WorkflowEngine } from './engine.js';
import type { RunResult } from './interfaces.js';
import type { WorkflowRef } from './workflow-ref.js';

/**
 * Test helper: enqueue a run and wait for it to settle (terminal or suspended). `engine.start` now
 * only enqueues (dispatch model), so this restores the old synchronous-result shape for assertions —
 * `const r = await startRun(engine, wf, input, id)`. Not for production use; production pairs `start`
 * with `waitForRun` (or a worker) explicitly.
 */
export function startRun(
  engine: WorkflowEngine,
  workflow: WorkflowRef,
  input: unknown,
  runId: string,
  opts?: StartOptions,
): Promise<RunResult> {
  // `start` is overloaded per ref kind (class | string); a `WorkflowRef` union fits neither overload,
  // and this is a thin test helper, so resolve to the string overload (engine handles both at runtime).
  return engine.start(workflow as string, input, runId, opts).then(() => engine.waitForRun(runId));
}
