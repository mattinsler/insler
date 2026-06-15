---
title: Getting started
description: From `bun add @insler/platform` to a scanned fleet, generated artifacts, and a planned, gated rollout.
---

This guide takes you from one install to a fleet scanned into a desired-state
model, deployment artifacts generated from it, and a rollout planned, applied,
and gated.

## 1. Install

```sh
bun add @insler/platform
```

That one package contains the three layers this guide uses — `/fleet`,
`/generator`, and `/reconciler`, each importable on its own. Its runtime
dependencies are exactly `@insler/service` (the declaration model) and the
`@insler/rpc` core, which the install brings with it. The `insler` binary is
the separate [`@insler/cli`](/reference/cli/) package:

```sh
bun add -d @insler/cli
```

## 2. Declare a service

Declarations are authored with the
[service subsystem](https://service.insler.dev)'s `defineService` — literal,
statically-analyzable intent around an rpc contract — in `*.service.ts` /
`*.def.ts` files the scanner discovers by convention:

```ts
// services/greeter.service.ts
import { Contract } from '@insler/rpc/contract';
import { defineService } from '@insler/service';
import { z } from 'zod';

const GreeterContract = Contract.create('greeter', {
  version: '1.0.0',
  methods: {
    greet: {
      input: z.object({ name: z.string() }),
      output: z.object({ message: z.string() }),
    },
  },
});

export const greeter = defineService({
  name: 'greeter',
  kind: 'ephemeral', // holds nothing between requests — may scale to zero
  contract: GreeterContract,
  needs: ['valkey'], // logical resource names, never connection strings
  scale: { on: 'queue-depth', min: 0, max: 20 },
});
```

## 3. Scan the fleet

`scanFleet` walks the tree, imports every candidate file, and folds the
declarations into a `FleetManifest` — services, dependency graph, and the
fleet-wide routing table — validating *cross-service* constraints (name and
identity uniqueness, route collisions, unknown call subjects) with file
locations on every error:

```ts
import { scanFleet } from '@insler/platform/fleet';

const fleet = await scanFleet({ cwd: './services' });
if (!fleet.manifest) {
  // The manifest is present only when errors is empty — never derive
  // artifacts from an invalid fleet.
  throw new Error(fleet.errors.map((e) => `[${e.kind}] ${e.message}`).join('\n'));
}
```

## 4. Generate artifacts

The generator is a pluggable, **deterministic** codegen engine: every
concrete output is a plugin, and `generate` is pure — same manifest and
options in, same files in the same order out. That determinism is what makes
the plan/diff downstream meaningful:

```ts
import { createGenerator, kubernetesPlugin, autoscalerPlugin } from '@insler/platform/generator';

const generator = createGenerator().use(kubernetesPlugin, autoscalerPlugin);
const generation = generator.generate(fleet.manifest, {
  target: 'kubernetes',
  outputDir: 'deploy',
  environment: 'dev',
});

await generator.write(generation, 'deploy'); // the only I/O
```

## 5. Plan and apply

The reconciler diffs desired state against actual state — read through the
small `StateProvider` seam — and produces a plain, reviewable plan. Apply it
ungated in development:

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

A plan carries a fingerprint of the `(desired, actual)` it was diffed from;
`apply` rejects a plan whose actual state has since moved — never a blind or
stale apply.

## 6. Gate it in production

`applyGated` layers the production policy over the same engine: the apply
only proceeds against live actual state, and **every attempt — accepted or
rejected — writes one audit record** (operator, timestamp, plan, blast
radius) through the `AuditSink` seam:

```ts
import { applyGated } from '@insler/platform/reconciler';

const outcome = await applyGated(reconciler, plan, {
  operator: 'matt@insler.dev',
  audit: { record: async (entry) => auditLog.write(JSON.stringify(entry) + '\n') },
});
outcome.outcome; // 'applied' | 'rejected' — both audited
```

## 7. Or drive it all from the CLI

The same pipeline is the `insler ` command set, composed by
[`@insler/cli`](/reference/cli/):

```sh
insler scan                                  # fleet summary, errors with locations
insler generate --out deploy --target kubernetes --env dev
insler plan --state .insler-state.json       # Atlas-style plan; --comment for a CI PR comment
insler apply --env production --operator me  # gated + audited (JSONL trail via --audit)
insler dev                                   # watch → re-scan → re-generate → auto-converge
```

`insler dev` is the ungated development inner loop — and it refuses
`--env production` outright; the production change path is always
`plan` + `apply`.

## Where to go next

- **The layers.** [`@insler/platform/fleet`](/reference/fleet/) — discovery
  and the desired-state model; [`@insler/platform/generator`](/reference/generator/)
  — the plugin engine and the shipped artifact plugins;
  [`@insler/platform/reconciler`](/reference/reconciler/) — plan/diff, apply
  policies, drift control.
- **The composition.** [`@insler/cli`](/reference/cli/) — every command and
  its programmatic export.
- **The stack underneath.** Declarations come from the
  [service subsystem](https://service.insler.dev), contracts from the
  [rpc subsystem](https://rpc.insler.dev) — and the rest of the
  [insler.dev](https://insler.dev) projects compose the same way.
