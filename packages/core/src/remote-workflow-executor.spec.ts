import type { Transport, WorkflowDecision, WorkflowRun, WorkflowTask } from './interfaces.js';
import { RemoteWorkflowExecutor } from './remote-workflow-executor.js';

function run(): WorkflowRun {
  return {
    id: 'r1',
    workflow: 'greet',
    workflowVersion: '1',
    input: 'davi',
    status: 'running',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('RemoteWorkflowExecutor', () => {
  it('dispatches a workflow task and resolves the matching decision (correlated by taskId)', async () => {
    let decide: ((d: WorkflowDecision) => Promise<void>) | undefined;
    let dispatched: WorkflowTask | undefined;
    const transport: Transport = {
      dispatch: async () => {},
      onResult: () => {},
      onHeartbeat: () => {},
      dispatchWorkflowTask: async (t) => {
        dispatched = t;
      },
      onDecision: (h) => {
        decide = h;
      },
    };
    const exec = new RemoteWorkflowExecutor(transport, 'py-wf');
    const p = exec.advance(run(), []);
    // the worker replies on the decisions channel with the same taskId
    await new Promise((r) => setImmediate(r));
    expect(dispatched?.group).toBe('py-wf');
    expect(dispatched?.workflow).toBe('greet');
    if (!decide) throw new Error('decision handler was not registered');
    if (!dispatched) throw new Error('no workflow task was dispatched');
    await decide({
      taskId: dispatched.taskId,
      runId: 'r1',
      status: 'completed',
      commands: [],
      output: { msg: 'hi' },
    });
    const decision = await p;
    expect(decision.status).toBe('completed');
    expect(decision.output).toEqual({ msg: 'hi' });
  });
});
