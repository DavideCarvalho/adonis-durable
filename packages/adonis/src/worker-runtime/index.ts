/**
 * `@adonis-agora/durable/worker` — the LEAN, store-less worker entry (design §4 packaging).
 *
 * This module and its whole transitive graph import NO Lucid (and no store at all), so a thin worker
 * pod's dependency graph stays lean without a separate package. That store-less-ness is a STRUCTURAL
 * fact enforced by the `no-lucid` test (test/worker-runtime/no-lucid.spec.ts), not a convention: it
 * walks this module's transitive `import` graph and fails if `@adonisjs/lucid` (or any store module)
 * ever appears. Keep it that way — only add imports that are themselves Lucid-free.
 *
 * A thin worker: build a transport (e.g. the wave-1 `BullMQTransport`), construct a {@link WorkerRuntime}
 * over it, register `app/steps` (and advertise `app/workflows` names) via the re-exported
 * `step-discovery` helpers, then `runtime.start()`. The `node ace durable:worker` command wires exactly
 * this from `config/durable.ts`.
 */
export {
  WorkerRuntime,
  WORKER_SDK,
  type WorkerRuntimeOptions,
  type WorkerTransport,
  type WorkerRuntimeLogger,
} from './worker-runtime.js';
export {
  NoopWorkerRegistry,
  RedisWorkerRegistry,
  type WorkerRegistry,
  type DescriptorRedis,
} from './registry.js';
export {
  workerDescriptorKey,
  workerDescriptorKeyPrefix,
  workerHeartbeatKey,
  effectivePrefix,
  routingToken,
} from './naming.js';

// The handshake descriptor surface (design §7) — re-exported for worker authors; itself Lucid-free.
export {
  CURRENT_PROTOCOL_VERSION,
  descriptorHash,
  heartbeatStatus,
  normalizeDescriptor,
  type WorkerDescriptor,
  type HeartbeatStatus,
  type WorkerLifecycle,
} from '../handshake/descriptor.js';

// Step registration/discovery helpers (the `app/steps` convention) — Lucid-free (fs + pure metadata).
export {
  registerStep,
  registerSteps,
  registerStepsFromDir,
  registerStepsFromBarrel,
  collectSteps,
  type StepServer,
  type DiscoveredStep,
  type StepsBarrel,
} from '../step-discovery.js';

// The shared pure worker body + step-handler type (the transport funnels tasks through it).
export { runStepHandler, type StepHandler } from '../protocol.js';

// The shared pure WORKFLOW-TURN body (replay history → decision) + its authoring surface — what lets a
// store-less worker execute workflow turns (design §4). Itself Lucid-free (imports only interface types).
export {
  runWorkflowTurn,
  isWorkflowTask,
  WorkflowStepFailedError,
  WorkflowNondeterminismError,
  WorkflowTurnCancelled,
  type WorkflowTurnCtx,
  type WorkflowBody,
  type WorkflowBodyResolver,
  type WorkflowTurnHandler,
  type RunWorkflowTurnOptions,
} from '../workflow-turn.js';
