# @adonis-agora/durable-eslint-plugin

## 0.2.0

### Minor Changes

- [`86819e0`](https://github.com/DavideCarvalho/adonis-durable/commit/86819e08666a307046e8845a7d9b9ed3685d7c53) - BaseWorkflow is the sole authoring form; `services/main`; dashboard login; signal/child/subscriber fixes

  **BREAKING — the `@Workflow` decorator is removed.** Author workflows with a
  `BaseWorkflow` subclass plus `static workflow = { name, version }`:

  ```ts
  // before
  @Workflow({ name: "charge", version: "1" })
  class ChargeWorkflow {
    async run(ctx: WorkflowCtx, input: Input) {}
  }

  // after
  export default class ChargeWorkflow extends BaseWorkflow {
    static workflow = { name: "charge", version: "1" };
    async run(ctx: WorkflowCtx, input: Input) {}
  }
  ```

  `workflowMeta()` now reads only the `static workflow` config; normalization is
  unchanged (version defaults to `'1'`). One authoring form means one thing to
  document, one thing to discover, and no decorator/metadata runtime.

  **Features**

  - `BaseWorkflow` with context-aware static `start`/`dispatch`. Call
    `ChargeWorkflow.start(input)` and it does the right thing by context: outside a
    workflow it enqueues on the engine and blocks until the run reaches a terminal
    state; inside one it starts a linked child and suspends the parent. `.dispatch`
    is the fire-and-forget twin, returning `{ runId }` without waiting.
  - `@adonis-agora/durable/services/main` — an idiomatic singleton import, so app
    code reaches the engine the way it reaches any other Adonis service.
  - Control-flow signal marker plus `isWorkflowControlFlowSignal`, so a workflow
    can tell a control-flow signal apart from a domain one.
  - Buffered events are now reliable: an event delivered before its waiter exists is
    no longer lost.
  - Dashboard built-in login screen via `dashboardAuth`.

  **Fixes**

  - Closed a lost-wake race in the signal waiter, and added the
    `removeSignalWaiter` SPI so a waiter can be torn down deterministically.
  - A child that fails to _start_ now surfaces the failure to the parent instead of
    stranding it. The parent used to wait forever on a child that never existed:
    the start was fire-and-forget, so nothing ever notified the parent. The child
    start is now deferred and its rejection is reported to the parent as a failed
    child result.
  - The Redis control plane now heals a silently-dead subscriber connection. A
    subscriber whose socket died without an error event stopped delivering messages
    while still looking healthy, and every wake-up routed through it was lost. A
    ping watchdog now detects the dead connection and forces a reconnect.
  - `BaseWorkflow.start` waits for terminal (matching the linked-child path), the
    steps hook is configurable, and the dashboard token comparison is
    constant-time.

  **eslint-plugin** — `no-nondeterminism` identifies a workflow's `run` body by the
  new authoring form (a `BaseWorkflow` subclass, or any class with a
  `static workflow` config) instead of the removed `@Workflow` decorator. Without
  this the rule would silently stop guarding every workflow in a 0.8 codebase.
