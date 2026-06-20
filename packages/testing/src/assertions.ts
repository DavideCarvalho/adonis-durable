import type { RunStatus, StateStore } from '@agora/durable-core';

async function requireRun(store: StateStore, runId: string) {
  const run = await store.getRun(runId);
  if (!run) throw new Error(`assertion failed: run ${runId} not found`);
  return run;
}

export async function assertRunStatus(
  store: StateStore,
  runId: string,
  status: RunStatus,
): Promise<void> {
  const run = await requireRun(store, runId);
  if (run.status !== status) {
    throw new Error(`expected run ${runId} to be "${status}", but it was "${run.status}"`);
  }
}

export async function assertOutput(
  store: StateStore,
  runId: string,
  expected: unknown,
): Promise<void> {
  const run = await requireRun(store, runId);
  if (JSON.stringify(run.output) !== JSON.stringify(expected)) {
    throw new Error(
      `expected run ${runId} output ${JSON.stringify(expected)}, got ${JSON.stringify(run.output)}`,
    );
  }
}

/** The names of the steps that have run, in order. */
export async function recordedSteps(store: StateStore, runId: string): Promise<string[]> {
  return (await store.listCheckpoints(runId)).map((cp) => cp.name);
}

/** Assert every named step ran (in any order). */
export async function assertStepsRan(
  store: StateStore,
  runId: string,
  names: string[],
): Promise<void> {
  const ran = await recordedSteps(store, runId);
  for (const name of names) {
    if (!ran.includes(name)) {
      throw new Error(`expected step "${name}" to have run; ran: [${ran.join(', ')}]`);
    }
  }
}

/** Assert a step ran exactly the given number of attempts (e.g. to verify retries). */
export async function assertStepAttempts(
  store: StateStore,
  runId: string,
  name: string,
  attempts: number,
): Promise<void> {
  const cp = (await store.listCheckpoints(runId)).find((c) => c.name === name);
  if (!cp) throw new Error(`expected step "${name}" to have run, but it did not`);
  if (cp.attempts !== attempts) {
    throw new Error(`expected step "${name}" to take ${attempts} attempt(s), took ${cp.attempts}`);
  }
}
