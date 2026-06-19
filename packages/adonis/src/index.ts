/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.1.0';

// Re-export the engine + all core primitives so apps import from one place.
export * from '@agora/durable-core';
export { defineConfig } from './define_config.js';
export type { DurableConfig } from './define_config.js';
