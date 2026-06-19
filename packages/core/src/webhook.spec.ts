import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine.js';
import { startRun } from './test-helpers.js';
import { InMemoryStateStore } from './testing/in-memory-state-store.js';

describe('ctx.webhook', () => {
  it('exposes a deterministic token/url and suspends until a POST delivers the payload', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      webhookUrl: (token) => `https://app.test/api/durable/webhooks/${token}`,
    });

    let issuedUrl = '';
    engine.register('wf', '1', async (ctx) => {
      const wh = ctx.webhook<{ ok: boolean }>();
      issuedUrl = wh.url ?? '';
      // In a real flow you'd hand wh.url to a third party inside a step here.
      await ctx.step('register', async () => 'registered');
      const payload = await wh.wait();
      return payload.ok;
    });

    const first = await startRun(engine, 'wf', {}, 'r1');
    expect(first.status).toBe('suspended');
    expect(issuedUrl).toBe('https://app.test/api/durable/webhooks/wh:r1:0');

    // The external system calls back → dashboard turns the POST into engine.signal(token, body).
    const resumed = await engine.signal('wh:r1:0', { ok: true });
    expect(resumed?.status).toBe('completed');
    expect(resumed?.output).toBe(true);
  });

  it('url is undefined when no webhookUrl builder is configured', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let url: string | undefined = 'unset';
    let token = '';
    engine.register('wf', '1', async (ctx) => {
      const wh = ctx.webhook();
      url = wh.url;
      token = wh.token;
      await wh.wait();
    });
    await startRun(engine, 'wf', {}, 'r2');
    expect(url).toBeUndefined();
    expect(token).toBe('wh:r2:0');
  });
});
