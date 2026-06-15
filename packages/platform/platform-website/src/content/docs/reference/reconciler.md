---
title: '@insler/platform/reconciler'
description: 'The plan/diff engine behind the StateProvider seam, plus the apply policies: dev auto-converge, gated and audited production applies, and the continuous drift control loop.'
sidebar:
  order: 3
---

The Atlas-style plan/diff engine. `createReconciler(provider)` wraps a
`StateProvider` — the small seam actual state is read through — and returns
`{ plan, detectDrift, apply, render }`:

```ts
import {
  createMemoryStateProvider,
  createReconciler,
  toResources,
} from '@insler/platform/reconciler';

const reconciler = createReconciler(createMemoryStateProvider());
const plan = await reconciler.plan(toResources(generation.files));

console.log(reconciler.render(plan)); // adds / changes / destroys — no-op when converged
await reconciler.apply(plan);
```

## Plans are plain data

A `Plan` is JSON-serializable, audit-loggable data: every path exactly once
in deterministic order, `summary` counts, `isNoOp`, and a **fingerprint** of
the `(desired, actual)` inputs it was diffed from. `apply` recomputes that
fingerprint against the provider's *current* actual and rejects stale plans —
optimistic concurrency; a plan is only valid against the state it was diffed
from. `renderPlan` gives the stable text form; `renderPlanComment` the CI PR
Markdown with blast radius.

## The StateProvider seam

`StateProvider` is `getActual()` / `getLastApplied()` / `setApplied(...)`.
**Drift** is actual diverging from the *last-applied* desired (not from
newly-generated desired). Real K8s/serverless backends implement this seam
later, never the engine; `createMemoryStateProvider` is the in-memory fake,
with `driftActual(...)` to inject out-of-band drift deterministically in
tests.

## Apply policies — layered, never baked in

The engine's `apply` is gate-free; policy composes on top:

- **`applyAuto(reconciler, plan)`** — no gate, no audit, no operator: the
  development speed path (`insler dev` stands on it).
- **`applyGated(reconciler, plan, { operator, audit, now? })`** — the
  production policy. **Every attempt — accepted or rejected — writes one
  `AuditRecord`** (operator, ISO-8601 timestamp, plan, `blastRadius`, reason)
  through the `AuditSink` seam; records round-trip `JSON.stringify`.
- **`createControlLoop(reconciler, options)`** — continuous drift control.
  Drift classifies as `replica-count`, `config-drift`, `missing-resource`, or
  `extra-resource`. Unmanaged `extra-resource` drift is **never corrected in
  any mode** (the loop must not fight another controller); production is
  alert-first for `missing-resource` and corrects safe categories only when
  opted in; development always corrects. A correction applies with
  `preserveLastApplied` — intent never changes during a correction.

## Inject the nondeterminism

The clock (`now`) and periodicity (`Ticker.next()`) are injected seams — the
loop never calls `setInterval` or sleeps, so tests drive passes
deterministically. The engine reads no declarations or artifacts from disk;
the caller brings desired state in (typically `toResources` over the
[generator](/reference/generator/)'s output).
