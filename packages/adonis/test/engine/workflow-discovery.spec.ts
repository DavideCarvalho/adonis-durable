import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { discoverWorkflows, registerWorkflowsFromDir } from '../../src/workflow-discovery.js';
import { Workflow, workflowMeta, workflowName } from '../../src/workflow-ref.js';

// Absolute path to the package src so a temp workflow module can import @Workflow without the alias.
const SRC = fileURLToPath(new URL('../../src', import.meta.url));

describe('@Workflow decorator', () => {
  it('stamps the registered name and full metadata (default version 1)', () => {
    @Workflow({ name: 'greet' })
    class Greet {
      async run(_ctx: unknown, input: { name: string }) {
        return `hi ${input.name}`;
      }
    }
    expect(workflowName(Greet as never)).toBe('greet');
    expect(workflowMeta(Greet)).toEqual({ name: 'greet', version: '1' });
  });

  it('carries version/tags/onEvent through the metadata', () => {
    @Workflow({ name: 'order', version: '2', tags: ['billing'], onEvent: ['order.placed'] })
    class Order {
      async run() {
        return 'done';
      }
    }
    expect(workflowMeta(Order)).toMatchObject({
      name: 'order',
      version: '2',
      tags: ['billing'],
      onEvent: ['order.placed'],
    });
  });
});

describe('app/workflows auto-discovery', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'durable-wf-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('discovers + registers an exported @Workflow class so it is runnable', async () => {
    await writeFile(
      join(dir, 'greet_workflow.ts'),
      `import { Workflow } from '${SRC}/workflow-ref.js'
       class GreetWorkflow {
         async run(_ctx, input) { return 'hi ' + input.name }
       }
       export default Workflow({ name: 'greet', version: '1' })(GreetWorkflow)`,
    );

    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const registered = await registerWorkflowsFromDir(engine, dir);
    expect(registered).toEqual([{ name: 'greet', version: '1' }]);

    const res = await startRun(engine, 'greet', { name: 'davi' }, 'g1');
    expect(res.output).toBe('hi davi');
  });

  it('discovers + registers a BaseWorkflow `static workflow` class (no decorator), runnable', async () => {
    await writeFile(
      join(dir, 'checkout_workflow.ts'),
      `import { BaseWorkflow } from '${SRC}/base-workflow.js'
       export default class CheckoutWorkflow extends BaseWorkflow {
         static workflow = { name: 'checkout', version: '1' }
         async run(_ctx, input) { return 'checkout:' + input.id }
       }`,
    );

    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const registered = await registerWorkflowsFromDir(engine, dir);
    expect(registered).toEqual([{ name: 'checkout', version: '1' }]);

    const res = await startRun(engine, 'checkout', { id: 'x' }, 'co1');
    expect(res.output).toBe('checkout:x');
  });

  it('discovers @Workflow classes in NESTED directories (matches make:workflow nested paths)', async () => {
    await mkdir(join(dir, 'billing'), { recursive: true });
    await writeFile(
      join(dir, 'billing', 'charge_workflow.ts'),
      `import { Workflow } from '${SRC}/workflow-ref.js'
       class ChargeWorkflow {
         async run(_ctx, input) { return 'charged:' + input.id }
       }
       export default Workflow({ name: 'billing.charge', version: '1' })(ChargeWorkflow)`,
    );

    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const registered = await registerWorkflowsFromDir(engine, dir);
    expect(registered).toEqual([{ name: 'billing.charge', version: '1' }]);

    const res = await startRun(engine, 'billing.charge', { id: 'x' }, 'c1');
    expect(res.output).toBe('charged:x');
  });

  it('returns an empty list for a missing directory (convention is opt-in)', async () => {
    expect(await discoverWorkflows(join(dir, 'does-not-exist'))).toEqual([]);
  });

  it('ignores non-workflow modules', async () => {
    await writeFile(join(dir, 'helpers.ts'), 'export const x = 1');
    expect(await discoverWorkflows(dir)).toEqual([]);
  });
});
