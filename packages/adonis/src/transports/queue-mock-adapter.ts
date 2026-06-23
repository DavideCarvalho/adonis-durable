import type { AcquiredJob, Adapter, JobData } from '@adonisjs/queue/types';

/**
 * A tiny in-memory `@adonisjs/queue` adapter for tests — implements just the surface the
 * `QueueTransport` touches (push/pop/complete/fail/destroy) as plain FIFO queues, plus throwing
 * stubs for the rest of the contract. No Redis, no Knex. `popFrom` mimics the real adapters'
 * atomic move (pending → active) so two transports sharing one instance never double-consume.
 */
export class MockAdapter implements Adapter {
  readonly pending = new Map<string, JobData[]>();
  readonly active = new Map<string, AcquiredJob>();
  workerId = '';
  destroyed = false;

  setWorkerId(id: string): void {
    this.workerId = id;
  }

  async pushOn(queue: string, jobData: JobData): Promise<void> {
    const list = this.pending.get(queue) ?? [];
    list.push(jobData);
    this.pending.set(queue, list);
  }

  async push(jobData: JobData): Promise<void> {
    await this.pushOn('default', jobData);
  }

  async popFrom(queue: string): Promise<AcquiredJob | null> {
    const list = this.pending.get(queue);
    if (!list || list.length === 0) return null;
    // Mirror the real adapters' priority ordering: lower `priority` number runs first (default 5 when
    // absent), FIFO among equal priorities. A plain FIFO queue (no priorities set) is unchanged.
    const DEFAULT_PRIORITY = 5;
    let bestIndex = 0;
    let bestPriority = list[0]?.priority ?? DEFAULT_PRIORITY;
    for (let i = 1; i < list.length; i += 1) {
      const candidate = list[i]?.priority ?? DEFAULT_PRIORITY;
      if (candidate < bestPriority) {
        bestIndex = i;
        bestPriority = candidate;
      }
    }
    const [job] = list.splice(bestIndex, 1);
    if (!job) return null;
    const acquired: AcquiredJob = { ...job, acquiredAt: Date.now() };
    this.active.set(job.id, acquired);
    return acquired;
  }

  async pop(): Promise<AcquiredJob | null> {
    return this.popFrom('default');
  }

  async completeJob(jobId: string): Promise<void> {
    this.active.delete(jobId);
  }

  async failJob(jobId: string): Promise<void> {
    this.active.delete(jobId);
  }

  async sizeOf(queue: string): Promise<number> {
    return this.pending.get(queue)?.length ?? 0;
  }

  async size(): Promise<number> {
    return this.sizeOf('default');
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }

  // --- Unused by the transport: present only to satisfy the Adapter contract. ---
  /* c8 ignore start */
  pushLater = this.#unsupported('pushLater');
  pushLaterOn = this.#unsupported('pushLaterOn');
  pushMany = this.#unsupported('pushMany');
  pushManyOn = this.#unsupported('pushManyOn');
  recoverStalledJobs = this.#unsupported('recoverStalledJobs');
  retryJob = this.#unsupported('retryJob');
  getJob = this.#unsupported('getJob');
  upsertSchedule = this.#unsupported('upsertSchedule');
  createSchedule = this.#unsupported('createSchedule');
  getSchedule = this.#unsupported('getSchedule');
  listSchedules = this.#unsupported('listSchedules');
  updateSchedule = this.#unsupported('updateSchedule');
  deleteSchedule = this.#unsupported('deleteSchedule');
  claimDueSchedule = this.#unsupported('claimDueSchedule');

  #unsupported(name: string) {
    return async (): Promise<never> => {
      throw new Error(`MockAdapter.${name} is not implemented`);
    };
  }
  /* c8 ignore stop */
}
