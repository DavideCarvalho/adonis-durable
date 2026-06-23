/**
 * A **workflow reference** is how one workflow names another to call it: either a registered workflow
 * **name** (a string — the only option across runtimes, e.g. a Python workflow) or, for a same-runtime
 * TypeScript workflow, its **class**. The class carries the input/output types through the call, so
 * `ctx.child(ShippingWorkflow, input)` type-checks the input and returns a typed result — while a
 * string stays available for the cross-runtime case.
 */

/**
 * The symbol the `@Workflow` decorator stamps a workflow's registered name onto, so a class ref can
 * be resolved back to its name. A global-registry symbol (`Symbol.for`) so it survives duplicate
 * copies of this package in a dependency tree.
 */
export const WORKFLOW_NAME_KEY: unique symbol = Symbol.for('@agora/durable:workflow-name');

/** Structural shape of a `@Workflow` class — its `run(ctx, input)` carries the input/output types. */
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
 * `@Workflow` class is resolved via the name the decorator stamped on it. Throws if a class was
 * never decorated (so it carries no registered name).
 */
export function workflowName(ref: WorkflowRef): string {
  if (typeof ref === 'string') return ref;
  const name = (ref as { [WORKFLOW_NAME_KEY]?: string })[WORKFLOW_NAME_KEY];
  if (!name) {
    throw new Error(
      `workflow class ${ref.name} has no registered name — is it decorated with @Workflow({ name })?`,
    );
  }
  return name;
}
