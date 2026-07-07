import app from '@adonisjs/core/services/app';
import { WorkflowEngine } from '../engine.js';

/**
 * Returns the singleton {@link WorkflowEngine} resolved from the container.
 *
 * Import it directly instead of resolving the engine yourself:
 *
 * ```ts
 * import engine from '@adonis-agora/durable/services/main'
 * ```
 */
let engine: WorkflowEngine;

await app.booted(async () => {
  engine = await app.container.make(WorkflowEngine);
});

export { engine as default };
