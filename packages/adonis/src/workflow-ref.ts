/**
 * A **workflow reference** is how one workflow names another to call it: either a registered workflow
 * **name** (a string — the only option across runtimes, e.g. a Python workflow) or, for a same-runtime
 * TypeScript workflow, its **class**. The class carries the input/output types through the call, so
 * `ctx.child(ShippingWorkflow, input)` type-checks the input and returns a typed result — while a
 * string stays available for the cross-runtime case.
 */

/** Options for a workflow's `static workflow = { name, version, … }` config (see {@link BaseWorkflow}). */
export interface WorkflowOptions {
  /** The registered workflow name (the cross-runtime identity, e.g. `order`). */
  name: string;
  /** Workflow version. Defaults to `'1'`. Register a new version for a breaking change. */
  version?: string;
  /** Searchable labels merged onto every run of this workflow. */
  tags?: string[];
  /** Wall-clock budget for the whole run (a duration string like `'5m'`, or ms). */
  executionTimeout?: string | number;
  /** Event names that start a run of this workflow when published (see `onEvent`). */
  onEvent?: string[];
}

/** The metadata read off a workflow class's `static workflow` config for discovery + registration. */
export interface WorkflowMeta extends WorkflowOptions {
  version: string;
}

/**
 * Read a class's {@link WorkflowMeta} — its name/version/tags/… — from its `static workflow =
 * { name, version, … }` config (the {@link BaseWorkflow} authoring form). Any absent `version` is
 * normalized to `'1'`. Returns `undefined` for a class carrying no valid config (a class with no
 * `static workflow`, or one whose `name` is not a string, is not a registrable workflow).
 */
export function workflowMeta(target: unknown): WorkflowMeta | undefined {
  if (typeof target !== 'function') return undefined;
  const config = (target as { workflow?: WorkflowOptions }).workflow;
  if (config && typeof config === 'object' && typeof config.name === 'string') {
    return { ...config, version: config.version ?? '1' };
  }
  return undefined;
}

/** Structural shape of a workflow class — its `run(ctx, input)` carries the input/output types. */
export type WorkflowClass<TInput = unknown, TOutput = unknown> = abstract new (
  ...args: never[]
) => {
  run(ctx: never, input: TInput): Promise<TOutput> | TOutput;
};

/** A workflow reference: a registered name (cross-runtime) or a workflow class (typed, same-runtime). */
export type WorkflowRef<TInput = unknown, TOutput = unknown> =
  | string
  | WorkflowClass<TInput, TOutput>;

/** The input type a workflow class's `run` accepts. */
export type WorkflowInputOf<C> = C extends abstract new (
  ...args: never[]
) => {
  run(ctx: never, input: infer I): unknown;
}
  ? I
  : unknown;

/** The output type a workflow class's `run` resolves to (Promise unwrapped). */
export type WorkflowOutputOf<C> = C extends abstract new (
  ...args: never[]
) => {
  run(ctx: never, input: never): infer R;
}
  ? Awaited<R>
  : unknown;

/**
 * Resolve a {@link WorkflowRef} to its registered workflow name: a string is returned as-is; a
 * workflow class is resolved via the name on its `static workflow` config. Throws if a class carries
 * no `static workflow` config (so it has no registered name).
 */
export function workflowName(ref: WorkflowRef): string {
  if (typeof ref === 'string') return ref;
  const name = workflowMeta(ref)?.name;
  if (!name) {
    throw new Error(
      `workflow class ${ref.name} has no registered name — does it declare \`static workflow = { name }\`?`,
    );
  }
  return name;
}
