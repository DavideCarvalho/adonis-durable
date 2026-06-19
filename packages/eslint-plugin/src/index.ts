import { noNondeterminism } from './no-nondeterminism.js';

export const rules = {
  'no-nondeterminism': noNondeterminism,
};

const plugin = {
  meta: { name: '@agora/durable-eslint-plugin', version: '0.1.0' },
  rules,
  configs: {} as Record<string, unknown>,
};

// Flat-config preset: `extends` it (or spread) to turn the rule on. Defined after `plugin` so it can
// reference the plugin object itself (the flat-config way to register a plugin + its rules).
plugin.configs.recommended = {
  plugins: { '@agora/durable': plugin },
  rules: { '@agora/durable/no-nondeterminism': 'error' },
};

export const configs = plugin.configs;
export { noNondeterminism };
export default plugin;
