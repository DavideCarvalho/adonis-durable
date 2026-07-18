import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { SignalTimeoutError } from '../../src/errors.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

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
      await ctx.localStep('register', async () => 'registered');
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

  it('wait({ timeoutMs }) throws SignalTimeoutError when the deadline passes before the callback', async () => {
    let now = 1000;
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, clock: () => now });
    let caught = false;
    engine.register('wf', '1', async (ctx) => {
      const wh = ctx.webhook<{ ok: boolean }>();
      try {
        await wh.wait({ timeoutMs: 5000 });
        return 'delivered';
      } catch (e) {
        if (e instanceof SignalTimeoutError) {
          caught = true;
          return 'timed-out';
        }
        throw e;
      }
    });

    const first = await startRun(engine, 'wf', {}, 'r3');
    expect(first.status).toBe('suspended');

    now = 7000; // past the 6000ms deadline
    await engine.resumeDueTimers(now);

    expect(caught).toBe(true);
    const run = await store.getRun('r3');
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe('timed-out');
  });

  it('wait({ timeoutMs }) resolves with the payload when the callback beats the deadline', async () => {
    let now = 1000;
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, clock: () => now });
    engine.register('wf', '1', async (ctx) => {
      const wh = ctx.webhook<{ ok: boolean }>();
      return wh.wait({ timeoutMs: 5000 });
    });

    const first = await startRun(engine, 'wf', {}, 'r4');
    expect(first.status).toBe('suspended');

    now = 2000; // before the deadline
    const resumed = await engine.signal('wh:r4:0', { ok: true });
    expect(resumed?.status).toBe('completed');
    expect(resumed?.output).toEqual({ ok: true });
  });
});

describe('ctx.webhook replay determinism', () => {
  it('a primitive AFTER a bounded wait keeps its position on the post-callback replay', async () => {
    // Regression: wait({ timeoutMs }) claims a deadline position on the pending pass. If the
    // completed-replay early return skipped that claim, the next primitive would land on the stamped
    // timeout:* checkpoint's seq and trip the NonDeterminism guard.
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('wf', '1', async (ctx) => {
      const wh = ctx.webhook<{ ok: boolean }>();
      const payload = await wh.wait({ timeoutMs: 60_000 });
      const stamped = await ctx.localStep('after-wait', async () => 'stamped');
      return { ok: payload.ok, stamped };
    });

    const first = await startRun(engine, 'wf', {}, 'r-replay');
    expect(first.status).toBe('suspended');
    const resumed = await engine.signal('wh:r-replay:0', { ok: true });
    expect(resumed?.status).toBe('completed');
    expect(resumed?.output).toEqual({ ok: true, stamped: 'stamped' });

    // Drive it once more end-to-end (a full cold replay) — must not throw NonDeterminismError.
    const replayed = await engine.resume('r-replay');
    expect(replayed?.status).toBe('completed');
  });
});
