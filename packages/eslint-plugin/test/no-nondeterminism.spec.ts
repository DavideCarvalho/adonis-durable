import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';
import { noNondeterminism } from '../src/no-nondeterminism.js';

// Wire the rule-tester's lifecycle hooks to vitest.
RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();

// The @Workflow class form (ported from the aviary).
const wfClass = (body: string) => `
  @Workflow({ name: 'wf', version: '1' })
  class W {
    async run(ctx) {
      ${body}
    }
  }
`;

// The function form: engine.register(name, version, fn) — Agora's primary API.
const wfFn = (body: string) => `
  engine.register('wf', '1', async (ctx) => {
    ${body}
  });
`;

ruleTester.run('no-nondeterminism', noNondeterminism, {
  valid: [
    // The ctx escape hatches.
    { code: wfClass('const t = await ctx.now(); const d = new Date(t);') },
    { code: wfFn('const t = await ctx.now();') },
    { code: wfFn('const d = new Date(await ctx.now());') },
    // Banned calls OUTSIDE any workflow body.
    { code: 'function f() { return Date.now(); }' },
    { code: 'const r = Math.random();' },
    // A non-`run` method of a @Workflow class is not the deterministic body.
    {
      code: `@Workflow({ name: 'wf', version: '1' }) class W { helper() { return Math.random(); } }`,
    },
    // A class method named run WITHOUT the @Workflow decorator is just a method.
    { code: 'class Plain { run() { return Date.now(); } }' },
    // Non-determinism inside a ctx.step / ctx.task callback is checkpointed — replay-safe.
    {
      code: wfClass("const s = await ctx.step('setup', async () => new Date().toISOString());"),
    },
    { code: wfFn("await ctx.step('setup', async () => { const r = Math.random(); });") },
    { code: wfFn("await ctx.task('t', async () => Date.now());") },
    // A plain register call to something else is not a workflow body.
    { code: "registry.register('x', () => Date.now());" },
  ],
  invalid: [
    // Class form.
    { code: wfClass('const t = Date.now();'), errors: [{ messageId: 'useNow' }] },
    { code: wfClass('const r = Math.random();'), errors: [{ messageId: 'useRandom' }] },
    { code: wfClass('const d = new Date();'), errors: [{ messageId: 'useNowDate' }] },
    { code: wfClass('const id = crypto.randomUUID();'), errors: [{ messageId: 'useUuid' }] },
    {
      code: wfClass('const id = globalThis.crypto.randomUUID();'),
      errors: [{ messageId: 'useUuid' }],
    },
    { code: wfClass('const t = performance.now();'), errors: [{ messageId: 'useNow' }] },
    // Function form.
    { code: wfFn('const t = Date.now();'), errors: [{ messageId: 'useNow' }] },
    { code: wfFn('const r = Math.random();'), errors: [{ messageId: 'useRandom' }] },
    { code: wfFn('const d = new Date();'), errors: [{ messageId: 'useNowDate' }] },
    { code: wfFn('const id = crypto.randomUUID();'), errors: [{ messageId: 'useUuid' }] },
    // A banned call in the orchestration body, even alongside steps, is still flagged.
    {
      code: wfFn("await ctx.step('a', async () => 1); const t = Date.now();"),
      errors: [{ messageId: 'useNow' }],
    },
  ],
});
