import type { z } from 'zod';
import type { RemoteStepDef, StepOptions } from './interfaces.js';

export interface RemoteStepConfig<TInput, TOutput> extends StepOptions {
  name: string;
  /** Worker group expected to handle this step. Defaults to the `name` prefix before the first dot. */
  group?: string;
  input: z.ZodType<TInput>;
  output: z.ZodType<TOutput>;
}

/**
 * Defines a typed handle to a step that runs on a remote worker. Call it from a workflow with
 * `ctx.call(step, input)`; a worker registers a handler under the same `name`.
 */
export function remoteStep<TInput, TOutput>(
  config: RemoteStepConfig<TInput, TOutput>,
): RemoteStepDef<TInput, TOutput> {
  return {
    ...config,
    group: config.group ?? config.name.split('.')[0] ?? config.name,
    __remote: true,
  };
}
