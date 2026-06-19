# @agora/durable-cli

AdonisJS ace commands to operate the [`@agora/durable`](../adonis) workflow engine.

## Install

```sh
node ace add @agora/durable-cli
```

This registers the commands barrel in your `adonisrc` (`rcFile.addCommand('@agora/durable-cli/commands')`).

## Commands

### `durable:work`

The long-running worker loop. Resolves the `WorkflowEngine` bound by `@agora/durable`'s provider and,
on an interval, runs:

- `runPending()` — pick up enqueued runs
- `recoverIncomplete()` — resume runs left incomplete by a crash/deploy
- `resumeDueTimers()` — resume suspended runs whose durable timers are due
- `sweepTimeouts()` — cancel runs past their execution timeout

```sh
node ace durable:work --interval=1000 --drain-timeout=10000
```

Stays alive until `SIGINT`/`SIGTERM`, then drains in-flight executions before exiting so a deploy
hands off cleanly.

### `durable:runs`

List recent runs from the configured store.

```sh
node ace durable:runs --status=failed --workflow=checkout --limit=50
```

### `durable:retry <runId>`

Re-enqueue a run for a worker to (re-)execute (replays its checkpoints, re-attempts the failed step).

```sh
node ace durable:retry run_abc123
```

Run `durable:work` (or any worker) to pick it up.
