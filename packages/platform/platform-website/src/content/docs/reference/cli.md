---
title: '@insler/cli'
description: 'The insler binary — scan, generate, plan, apply, and dev, composing the platform layers; every command also exported programmatically with injectable IO.'
sidebar:
  order: 4
---

The `insler` binary: argv parsing, usage, exit codes, and the *composition*
of the platform layers. It is the top of the platform stack — it depends on
`@insler/platform`; nothing depends on it — and it stays thin: anything
reusable lives in the umbrella's entrypoints.

```sh
bun add -d @insler/cli
```

## Commands

| Command | Composes | Does |
| --- | --- | --- |
| `insler scan` | [`/fleet`](/reference/fleet/) | Scans the tree, prints a fleet summary (or `--json` for the manifest); invalid fleets report every error with its file locations and exit non-zero |
| `insler generate` | [`/generator`](/reference/generator/) | Generates artifacts — `--out`, `--target`, `--env`, `--dry-run` |
| `insler plan` | [`/reconciler`](/reference/reconciler/) | Read-only Atlas-style plan against the `--state` snapshot; `--comment` emits the CI PR Markdown with blast radius |
| `insler apply` | [`/reconciler`](/reference/reconciler/) | Applies the plan; **gated when `--env production`**: `applyGated` with a JSONL `AuditSink` at `--audit`, operator from `--operator` / `$INSLER_OPERATOR` / `$USER` |
| `insler dev` | all three | The development inner loop: watch declarations → re-scan → re-generate → diff → ungated auto-converge. **Refuses `--env production` outright** — the production change path is `plan` + `apply` |

Exit code 0 on success; non-zero on an invalid fleet, a refused environment,
a rejected production plan, or bad usage (which prints usage).

## The programmatic surface

Every command is also exported as a function with injectable IO — `runScan`,
`runGenerate`, `runPlan`, `runApply`, `runDev` (plus `converge` and
`watchDeclarations`) — so the same composition is scriptable and testable
without spawning a process:

```ts
import { runScan } from '@insler/cli';

const code = await runScan(
  { cwd: './services' },
  { out: (line) => console.log(line), err: (line) => console.error(line) }
);
```

Every dependency is a seam: the scan function, the state-provider factory,
the watch source, the clock. The dev loop's orchestration lives here — in the
composition layer — so the engine underneath stays scanner-free.

## Boundaries

No codegen, diff, or apply-policy logic lives in this package; it is command
wiring over the [fleet](/reference/fleet/), [generator](/reference/generator/),
and [reconciler](/reference/reconciler/) entrypoints. `insler dev` never
grows gating or audit features — production changes go through `plan` +
`apply`.
