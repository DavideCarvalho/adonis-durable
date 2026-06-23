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

/**
 * The symbol the `@Workflow` decorator stamps the full options onto (name + version + tags …), so
 * auto-discovery can register the class against the engine. A global-registry symbol so it survives
 * duplicate copies of this package in a dependency tree (mirrors {@link WORKFLOW_NAME_KEY}).
 */
export const WORKFLOW_META_KEY: unique symbol = Symbol.for('@agora/durable:workflow-meta');

/** Options passed to `@Workflow({ name, version, … })`. */
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

/** The metadata the `@Workflow` decorator stamps onto a class for discovery + registration. */
export interface WorkflowMeta extends WorkflowOptions {
  version: string;
}

/**
 * Class decorator marking a class as a durable workflow. Stamps the registered name (so a class ref
 * resolves via {@link workflowName}) and the full options (so the provider's `app/workflows`
 * auto-discovery can register it on the engine — no manual `engine.register(...)`). The class must
 * expose `run(ctx, input)`; that method becomes the workflow body.
 *
 * ```ts
 * @Workflow({ name: 'order', version: '1' })
 * export default class OrderWorkflow {
 *   async run(ctx: WorkflowCtx, input: { id: string }) { ... }
 * }
 * ```
 */
export function Workflow(options: WorkflowOptions) {
  return <T extends abstract new (...args: never[]) => { run(ctx: never, input: never): unknown }>(
    target: T,
  ): T => {
    const meta: WorkflowMeta = { ...options, version: options.version ?? '1' };
    Object.defineProperty(target, WORKFLOW_NAME_KEY, {
      value: meta.name,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(target, WORKFLOW_META_KEY, {
      value: meta,
      enumerable: false,
      configurable: true,
    });
    return target;
  };
}

/** Read the {@link WorkflowMeta} a `@Workflow` decorator stamped on a class, or `undefined`. */
export function workflowMeta(target: unknown): WorkflowMeta | undefined {
  if (typeof target !== 'function') return undefined;
  return (target as { [WORKFLOW_META_KEY]?: WorkflowMeta })[WORKFLOW_META_KEY];
}

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
