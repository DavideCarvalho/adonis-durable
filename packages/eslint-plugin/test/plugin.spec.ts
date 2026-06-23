import { describe, expect, it } from 'vitest';
import plugin, { configs, rules } from '../src/index.js';

describe('plugin', () => {
  it('exposes the no-nondeterminism rule', () => {
    expect(rules['no-nondeterminism']).toBeDefined();
    expect(plugin.rules['no-nondeterminism']).toBe(rules['no-nondeterminism']);
  });

  it('exposes a flat-config recommended preset that turns the rule on', () => {
    const recommended = configs.recommended as {
      plugins: Record<string, unknown>;
      rules: Record<string, string>;
    };
    expect(recommended.plugins['@adonis-agora/durable']).toBe(plugin);
    expect(recommended.rules['@adonis-agora/durable/no-nondeterminism']).toBe('error');
  });

  it('carries plugin meta', () => {
    expect(plugin.meta.name).toBe('@adonis-agora/durable-eslint-plugin');
  });
});
