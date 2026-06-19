import { FatalError } from './errors.js';
import type { WorkflowCtx } from './interfaces.js';

/** One operation on a durable entity: mutate `state` in place and/or return a result. */
export type EntityHandler<S = unknown> = (state: S, arg: unknown) => unknown | Promise<unknown>;

/** A durable keyed entity (a virtual object): per-key serialized handlers over durable state. */
export interface EntityConfig<S = unknown> {
  /** Build the initial state for a fresh key. */
  initialState: () => S;
  /** Operation handlers, keyed by op name. Each runs serially per key, exactly once. */
  handlers: Record<string, EntityHandler<S>>;
}

/** The slice of the engine the entity subsystem needs (so it stays a standalone module). */
export interface EntityHost {
  register(
    name: string,
    version: string,
    fn: (ctx: WorkflowCtx, input: unknown) => Promise<unknown>,
  ): void;
  signalWithStart(
    workflow: string,
    input: unknown,
    runId: string,
    signal: { token: string; payload?: unknown },
  ): Promise<{ runId: string }>;
  getEvent<T>(runId: string, key: string): Promise<T | undefined>;
  signal(token: string, payload: unknown): Promise<unknown>;
}

const ENTITY_WORKFLOW = '__entity';
const entityRunId = (name: string, key: string): string => `entity:${name}:${key}`;

/**
 * Durable keyed **entities** (virtual objects): a keyed actor whose handlers run **serialized per
 * key** over **durable state**, exactly once. Each key is one long-lived run (`entity:<name>:<key>`)
 * processing ops in order. Drive it with `signal` (fire) or `ctx.callEntity` (call + await result),
 * read state with `getState`. Registers its built-in runner on construction.
 */
export class Entities {
  private readonly configs = new Map<string, EntityConfig>();

  constructor(private readonly host: EntityHost) {
    host.register(ENTITY_WORKFLOW, '1', (ctx, input) => this.run(ctx, input));
  }

  register<S>(name: string, config: EntityConfig<S>): void {
    this.configs.set(name, config as EntityConfig);
  }

  /** Deliver an op to an entity's runner, starting it on first contact. `reply` (a signal token)
   *  receives the handler's result, for `ctx.callEntity`. */
  dispatch(
    name: string,
    key: string,
    op: string,
    arg: unknown,
    reply?: string,
  ): Promise<{ runId: string }> {
    const runId = entityRunId(name, key);
    return this.host.signalWithStart(ENTITY_WORKFLOW, { name, key }, runId, {
      token: runId,
      payload: { op, arg, reply },
    });
  }

  async signal(name: string, key: string, op: string, arg?: unknown): Promise<void> {
    await this.dispatch(name, key, op, arg);
  }

  getState<S = unknown>(name: string, key: string): Promise<S | undefined> {
    return this.host.getEvent<S>(entityRunId(name, key), 'state');
  }

  /** The built-in runner: one long-lived run per key, processing ops serially over state. */
  private async run(ctx: WorkflowCtx, input: unknown): Promise<unknown> {
    const { name, key } = input as { name: string; key: string };
    const config = this.configs.get(name);
    if (!config) throw new FatalError(`entity "${name}" is not registered`);
    const token = entityRunId(name, key);
    let state = config.initialState();
    for (let i = 0; ; i += 1) {
      const msg = (await ctx.waitForSignal(token)) as { op: string; arg: unknown; reply?: string };
      // Run the handler and snapshot the (possibly mutated) state in ONE checkpoint, so replay
      // restores the state from the checkpoint instead of re-running the handler.
      const out = await ctx.step(`op:${i}`, async () => {
        const handler = config.handlers[msg.op];
        if (!handler) throw new FatalError(`entity "${name}" has no handler for op "${msg.op}"`);
        const result = await handler(state, msg.arg);
        return { result, state };
      });
      state = out.state; // carry state forward (and restore it from the checkpoint on replay)
      await ctx.setEvent('state', state); // publish for getState
      if (msg.reply) {
        await ctx.step(`reply:${i}`, async () => {
          await this.host.signal((msg as { reply: string }).reply, out.result);
        });
      }
    }
  }
}
