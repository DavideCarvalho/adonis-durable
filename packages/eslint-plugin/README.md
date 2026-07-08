# @adonis-agora/durable-eslint-plugin

ESLint rules enforcing **workflow determinism** for [`@adonis-agora/durable`](../adonis). A durable workflow
body is replayed from its checkpoints on every resume, so any non-deterministic source read directly
in the orchestration body (rather than recorded once inside a `ctx.step`) silently corrupts the run.
This plugin flags them.

## Install

```sh
npm i -D @adonis-agora/durable-eslint-plugin
```

## Usage (flat config)

```js
// eslint.config.js
import durable from '@adonis-agora/durable-eslint-plugin';

export default [durable.configs.recommended];
```

Or wire it manually:

```js
import durable from '@adonis-agora/durable-eslint-plugin';

export default [
  {
    plugins: { '@adonis-agora/durable': durable },
    rules: { '@adonis-agora/durable/no-nondeterminism': 'error' },
  },
];
```

## Rules

### `no-nondeterminism`

Disallows non-deterministic sources inside a durable workflow body — both the function form
(`engine.register('wf', '1', async (ctx) => { … })`) and a workflow class's `run` method (a
`BaseWorkflow` subclass / `static workflow` config):

| Flagged                | Use instead              |
| ---------------------- | ------------------------ |
| `Date.now()`           | `ctx.now()`              |
| `performance.now()`    | `ctx.now()`              |
| `new Date()`           | `new Date(await ctx.now())` |
| `Math.random()`        | `ctx.random()`           |
| `crypto.randomUUID()`  | `ctx.uuid()`             |

Calls inside a `ctx.step(...)` / `ctx.task(...)` callback are **not** flagged: a step body runs once
and is checkpointed, so non-determinism there is replay-safe.
