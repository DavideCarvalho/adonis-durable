import {
  InMemoryStateStore,
  type StepCheckpoint,
  WorkflowEngine,
  type WorkflowRun,
} from '@agora/durable-core';

export interface RunHistory {
  run: WorkflowRun;
  checkpoints: StepCheckpoint[];
}

/**
 * Replay a recorded run's history against the CURRENT workflow code and throw if they diverged.
 *
 * Capture a real (ideally in-flight or representative) run from production —
 * `{ run: await store.getRun(id), checkpoints: await store.listCheckpoints(id) }` — commit it as a
 * fixture, and assert here in CI. If a code change renamed/reordered/removed a step at a position the
 * history already recorded, the engine raises a `NonDeterminismError` on replay and this rethrows it,
 * catching the break *before* it reaches an in-flight run on deploy (the moment you'd otherwise
 * silently replay the wrong checkpoint into the wrong step). Register the workflow exactly as the app
 * does:
 *
 * ```ts
 * await assertReplayable((engine) => engine.register('pipeline', '1', pipeline.run), fixture);
 * ```
 */
export async function assertReplayable(
  register: (engine: WorkflowEngine) => void,
  history: RunHistory,
): Promise<void> {
  const store = new InMemoryStateStore();
  // Seed as a suspended run with no lock so resume() replays the body against the recorded
  // checkpoints — no transport is wired, so nothing new is dispatched.
  await store.createRun({
    ...history.run,
    status: 'suspended',
    lockedBy: undefined,
    lockedUntil: undefined,
  });
  for (const cp of history.checkpoints) await store.saveCheckpoint(cp);

  const engine = new WorkflowEngine({ store });
  register(engine);
  const result = await engine.resume(history.run.id);
  if (result.status === 'failed' && result.error?.message?.startsWith('non-determinism')) {
    const err = new Error(result.error.message);
    err.name = 'NonDeterminismError';
    throw err;
  }
}
