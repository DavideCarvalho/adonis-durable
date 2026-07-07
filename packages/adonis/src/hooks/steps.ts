import type { IndexGenerator } from '@adonisjs/assembler/index_generator';

/**
 * Where the generated steps barrel is written, relative to the app root. The durable provider imports
 * THIS path at boot (build-time codegen) instead of scanning `app/steps` with `readdir` at runtime.
 * Kept in sync with the module the provider imports.
 */
export const GENERATED_STEPS_OUTPUT = '.adonisjs/durable/steps.ts';

/** Options for {@link stepsHook} — mirror the relevant `IndexGenerator.add` knobs. */
export interface StepsHookOptions {
  /** Directory the generator scans for step modules, relative to the app root. Default `app/steps`. */
  source?: string;
  /** Import alias the generated barrel uses for each step module. Default `#steps`. */
  importAlias?: string;
  /** Output path for the generated barrel, relative to the app root. Default `.adonisjs/durable/steps.ts`. */
  output?: string;
}

/**
 * An AdonisJS **Assembler `init` hook** that generates a typed barrel of the app's `app/steps/`
 * directory at build/dev time — exactly how `@adonisjs/core` generates the controllers/events barrels
 * and how {@link import('./workflows.js').workflowsHook} does for `app/workflows`. The provider
 * imports the generated `.adonisjs/durable/steps.ts` at boot and registers every `@Step`/`defineStep`
 * export it finds on the transport (falling back to the runtime scan when the barrel is absent).
 *
 * Register it in `adonisrc.ts`:
 *
 * ```ts
 * export default defineConfig({
 *   hooks: {
 *     init: [() => import('@adonis-agora/durable/hooks/steps')],
 *   },
 * })
 * ```
 */
export function stepsHook(options: StepsHookOptions = {}) {
  const source = options.source ?? 'app/steps';
  const importAlias = options.importAlias ?? '#steps';
  const output = options.output ?? GENERATED_STEPS_OUTPUT;

  return {
    run(_parent: unknown, _hooks: unknown, indexGenerator: IndexGenerator): void {
      indexGenerator.add('steps', {
        source,
        as: 'barrelFile',
        exportName: 'steps',
        importAlias,
        removeSuffix: 'step',
        skipSegments: ['steps'],
        output,
        comment: true,
      });
    },
  };
}

/** The default export is the hook object itself, so `() => import('@adonis-agora/durable/hooks/steps')`
 *  in `adonisrc.ts` resolves to a ready hook (the assembler calls its `run`). */
export default stepsHook();
