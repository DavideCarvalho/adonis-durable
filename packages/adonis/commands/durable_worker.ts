import { BaseCommand } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import type { DurableConfig } from '../src/define_config.js';
import type { ControlPlane, Transport } from '../src/interfaces.js';
import { InMemoryTransport } from '../src/testing/in-memory-transport.js';
import { NoopWorkerRegistry } from '../src/worker-runtime/index.js';
import { registerStepsFromDir } from '../src/worker-runtime/index.js';
import { WorkerRuntime, type WorkerTransport } from '../src/worker-runtime/index.js';
import { discoverWorkflows } from '../src/workflow-discovery.js';

/**
 * `node ace durable:worker` — the **store-less** task-consumer loop for a `role: 'tenant'` worker pod
 * (design §3). Distinct from `durable:work` (the store-backed dispatch/recovery/timers loop, which
 * this command deliberately does NOT clobber): a store-less worker owns no durable state — it builds a
 * transport from `config/durable.ts`, registers `app/steps` (and advertises `app/workflows` names) on a
 * {@link WorkerRuntime}, then consumes `${P}-tasks-<token>` tasks (executed through the shared
 * `runStepHandler`, results published) and advertises its {@link import('../src/handshake/descriptor.js').WorkerDescriptor}
 * + heartbeat. Stays alive until SIGINT/SIGTERM, then drains.
 *
 * NOTE for the integrator (wave-3 provider branch): this command constructs its own transport +
 * runtime from config so it works standalone today. Once the provider grows a `role: 'tenant'` branch
 * that (a) does NOT build a store-backed `WorkflowEngine` and (b) binds a ready `WorkerRuntime` (with a
 * `RedisWorkerRegistry` keyed off the tenant transport's Redis connection), prefer resolving that bound
 * runtime here. Until then descriptor advertising uses {@link NoopWorkerRegistry} unless a registry is
 * wired — see the TODO below.
 */
export default class DurableWorker extends BaseCommand {
  static override commandName = 'durable:worker';
  static override description =
    'Run the store-less durable worker (consume tasks, execute step bodies, advertise descriptor)';
  static override options: CommandOptions = { startApp: true, staysAlive: true };

  override async run(): Promise<void> {
    const config = this.app.config.get<DurableConfig>('durable', {});
    if (config.role !== 'tenant') {
      this.logger.warning(
        `durable:worker is the store-less worker for role 'tenant'; config.role is '${config.role ?? 'standalone'}'. Continuing, but a store-backed role should use durable:work.`,
      );
    }

    const transport = await this.#resolveTransport(config);
    if (typeof (transport as Partial<WorkerTransport>).handle !== 'function') {
      throw new Error(
        `@agora/durable: the selected transport ("${config.transport ?? 'memory'}") cannot serve handlers (no handle()), so a store-less worker has nothing to consume.`,
      );
    }
    transport.useNamespace?.(config.namespace ?? 'default');

    const partition = (config as { partition?: string }).partition ?? config.namespace ?? 'default';

    // TODO(integrator): pass a `RedisWorkerRegistry` (built from the same connection the tenant
    // transport uses) so the descriptor + heartbeat are actually published on the shared Redis. Until
    // the wave-3 tenant provider branch exposes that connection, advertising is a no-op.
    const runtime = new WorkerRuntime({
      transport: transport as WorkerTransport,
      partition,
      ...(config.namespace !== undefined ? { namespace: config.namespace } : {}),
      ...(config.instanceId !== undefined ? { instanceId: config.instanceId } : {}),
      ...((config as { capabilities?: string[] }).capabilities !== undefined
        ? { capabilities: (config as { capabilities?: string[] }).capabilities }
        : {}),
      registry: new NoopWorkerRegistry(),
      logger: { info: (m) => this.logger.info(m), error: (m) => this.logger.error(m) },
      onError: (err) => this.logger.error(`worker-runtime advertisement error: ${String(err)}`),
    });

    // Register `app/steps` (served by the transport) + advertise `app/workflows` names.
    if (config.stepsPath !== false) {
      const stepsDir = this.app.makePath(config.stepsPath ?? 'app/steps');
      const steps = await registerStepsFromDir(runtime, stepsDir);
      this.logger.info(
        `registered ${steps.length} step handler(s) from ${config.stepsPath ?? 'app/steps'}`,
      );
    }
    if (config.workflowsPath !== false) {
      const workflowsDir = this.app.makePath(config.workflowsPath ?? 'app/workflows');
      const workflows = await discoverWorkflows(workflowsDir);
      runtime.registerWorkflowNames(workflows.map((w) => w.meta.name));
      this.logger.info(
        `advertising ${workflows.length} workflow name(s) from ${config.workflowsPath ?? 'app/workflows'}`,
      );
    }

    let stop!: () => void;
    const stopSignal = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const onSignal = (): void => {
      this.logger.info('shutdown signal received — stopping store-less worker…');
      stop();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    await runtime.start();
    this.logger.info(`durable:worker started (partition ${partition})`);
    await stopSignal;
    await runtime.stop();

    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await this.terminate();
  }

  /** Build the transport from `config/durable.ts` — the same resolution the provider uses, so the
   *  worker lands on the SAME queues as the control-plane. In-memory default when no transport named. */
  async #resolveTransport(
    config: DurableConfig,
  ): Promise<Transport & Partial<ControlPlane> & Partial<WorkerTransport>> {
    const name = config.transport;
    if (!name) return new InMemoryTransport();
    const factory = config.transports?.[name];
    if (!factory) {
      throw new Error(
        `@agora/durable: config.transport is "${name}", but config.transports.${name} is not defined`,
      );
    }
    return factory({ app: this.app });
  }
}
