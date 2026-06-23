import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkflowEngine } from './engine.js';
import { type WorkflowMeta, workflowMeta } from './workflow-ref.js';

/** A discovered, decorated workflow class plus the metadata its `@Workflow` decorator stamped. */
export interface DiscoveredWorkflow {
  meta: WorkflowMeta;
  cls: new () => { run(ctx: unknown, input: unknown): Promise<unknown> | unknown };
}

/**
 * Register a single `@Workflow`-decorated class on the engine: instantiate it once and bind its
 * `run(ctx, input)` as the workflow body via `engine.register`. The low-level
 * `engine.register(name, version, fn)` stays the escape hatch — this is the convenience the
 * `app/workflows` convention builds on. No-op (returns `false`) for an undecorated class.
 */
export function registerWorkflowClass(engine: WorkflowEngine, cls: unknown): boolean {
  const meta = workflowMeta(cls);
  if (!meta) return false;
  const Ctor = cls as new () => { run(ctx: unknown, input: unknown): Promise<unknown> | unknown };
  const instance = new Ctor();
  engine.register(
    meta.name,
    meta.version,
    (ctx, input) => Promise.resolve(instance.run(ctx, input)),
    {
      ...(meta.tags ? { tags: meta.tags } : {}),
      ...(meta.executionTimeout !== undefined ? { executionTimeout: meta.executionTimeout } : {}),
      ...(meta.onEvent ? { onEvent: meta.onEvent } : {}),
    },
  );
  return true;
}

/**
 * Scan a directory for modules and collect every exported `@Workflow`-decorated class (the default
 * export and any named export are considered). Used by the provider to auto-register the
 * `app/workflows` convention — mirroring `@adonisjs/queue`'s `app/jobs`. Missing directory →
 * empty list (the convention is opt-in: no `app/workflows`, nothing to register).
 */
export async function discoverWorkflows(dir: string): Promise<DiscoveredWorkflow[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const found: DiscoveredWorkflow[] = [];
  const seen = new Set<unknown>();
  for (const entry of entries.sort()) {
    if (!/\.(js|ts)$/.test(entry) || /\.d\.ts$/.test(entry)) continue;
    const mod = (await import(pathToFileURL(join(dir, entry)).href)) as Record<string, unknown>;
    for (const exported of Object.values(mod)) {
      if (seen.has(exported)) continue;
      const meta = workflowMeta(exported);
      if (!meta) continue;
      seen.add(exported);
      found.push({
        meta,
        cls: exported as DiscoveredWorkflow['cls'],
      });
    }
  }
  return found;
}

/**
 * Discover every `@Workflow` class under `dir` and register each on the engine. Returns the
 * registered metadata so the caller can log what was wired. Best-effort over a missing directory.
 */
export async function registerWorkflowsFromDir(
  engine: WorkflowEngine,
  dir: string,
): Promise<WorkflowMeta[]> {
  const discovered = await discoverWorkflows(dir);
  for (const { cls } of discovered) registerWorkflowClass(engine, cls);
  return discovered.map((d) => d.meta);
}
