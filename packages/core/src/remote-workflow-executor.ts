import type {
  HistoryEvent,
  Transport,
  WorkflowDecision,
  WorkflowExecutor,
  WorkflowRun,
  WorkflowTask,
} from './interfaces.js';

let taskCounter = 0;

/**
 * A {@link WorkflowExecutor} backed by a {@link Transport}: it advances a remote workflow by
 * dispatching a {@link WorkflowTask} over the broker and awaiting the matching {@link WorkflowDecision}
 * (correlated by `taskId`). Pass one to `engine.registerRemote(name, version, { group, executor })` so
 * a workflow authored in another SDK (e.g. the Python `durable-worker`) is driven over Redis/BullMQ.
 *
 * Recovery-safe: if the engine crashes awaiting a decision, the re-drive dispatches a fresh task with
 * the same history — the worker's replay is deterministic, so it returns the same decision; a late
 * decision for the old `taskId` simply finds no waiter and is dropped.
 */
export class RemoteWorkflowExecutor implements WorkflowExecutor {
  private readonly pending = new Map<string, (decision: WorkflowDecision) => void>();
  private subscribed = false;

  constructor(
    private readonly transport: Transport,
    private readonly group: string,
    private readonly opts: { timeoutMs?: number } = {},
  ) {}

  private ensureSubscribed(): void {
    if (this.subscribed) return;
    if (!this.transport.onDecision) {
      throw new Error('transport does not support workflow decisions (onDecision)');
    }
    this.subscribed = true;
    this.transport.onDecision(async (decision) => {
      const resolve = this.pending.get(decision.taskId);
      if (resolve) {
        this.pending.delete(decision.taskId);
        resolve(decision);
      }
    });
  }

  async advance(run: WorkflowRun, history: HistoryEvent[]): Promise<WorkflowDecision> {
    if (!this.transport.dispatchWorkflowTask) {
      throw new Error('transport does not support workflow tasks (dispatchWorkflowTask)');
    }
    this.ensureSubscribed();
    taskCounter += 1;
    const taskId = `${run.id}:wf:${taskCounter}`;
    const task: WorkflowTask = {
      taskId,
      runId: run.id,
      workflow: run.workflow,
      workflowVersion: run.workflowVersion,
      input: run.input,
      history,
      group: this.group,
      attempt: 1,
    };
    const decision = new Promise<WorkflowDecision>((resolve, reject) => {
      this.pending.set(taskId, resolve);
      if (this.opts.timeoutMs) {
        const timer = setTimeout(() => {
          this.pending.delete(taskId);
          reject(new Error(`workflow task ${taskId} timed out after ${this.opts.timeoutMs}ms`));
        }, this.opts.timeoutMs);
        (timer as { unref?: () => void }).unref?.();
      }
    });
    await this.transport.dispatchWorkflowTask(task);
    return decision;
  }
}
