# platform — Infrastructure from code

Turn `defineService` declarations into running infrastructure. The `insler`
CLI scans your services into a desired-state model, generates deployment
artifacts through a plugin-based generator — Kubernetes, autoscaling, edge
routing, secret bindings — and reconciles with plan/diff applies:
auto-converge in development, gated and audited in production.

**Full documentation: [platform.insler.dev](https://platform.insler.dev)**

## Install

One install brings all three platform layers — fleet scanning, artifact
generation, plan/diff reconciliation — as separately importable entrypoints,
with the declaration stack underneath (`@insler/service` and the `@insler/rpc`
core) arriving as its runtime dependencies:

```sh
bun add @insler/platform
```

The `insler` binary ships as its own package, so projects that drive the
layers programmatically never carry command-line wiring:

```sh
bun add -d @insler/cli
```

## From a declaration to a plan

Declarations are ordinary `@insler/service` files — `defineService` around an
rpc contract — in `*.service.ts` files the scanner discovers by convention:

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
  scale: { on: 'queue-depth', min: 0, max: 20 },
});
```

Scan the tree into the desired-state model, generate artifacts, and plan the
rollout — each layer is one import, adoptable on its own:

```ts
import { scanFleet } from '@insler/platform/fleet';
import { createGenerator, kubernetesPlugin } from '@insler/platform/generator';
import {
  createMemoryStateProvider,
  createReconciler,
  toResources,
} from '@insler/platform/reconciler';

const fleet = await scanFleet({ cwd: './services' });
if (!fleet.manifest) throw new Error(fleet.errors.map((e) => e.message).join('\n'));

const generator = createGenerator().use(kubernetesPlugin);
const generation = generator.generate(fleet.manifest, {
  target: 'kubernetes',
  outputDir: 'deploy',
  environment: 'development',
});

const reconciler = createReconciler(createMemoryStateProvider());
const plan = await reconciler.plan(toResources(generation.files));
console.log(reconciler.render(plan)); // adds / changes / destroys — no-op when converged
```

The same pipeline is the `insler` CLI's command set — `insler scan`,
`insler generate`, `insler plan`, `insler apply` (gated and audited when
`--env production`), and `insler dev`, the watch → re-scan → re-generate →
auto-converge inner loop.

## What's in this directory

### The umbrella package — `@insler/platform` ([`platform/`](./platform/README.md))

platform is a three-entrypoint umbrella: each layer imports as its own
subpath and stands alone — bring your own manifest to the generator, or your
own desired state to the reconciler.

| Entrypoint                     | Purpose                                                                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@insler/platform/fleet`       | Convention-based discovery of `defineService` declarations and the `FleetManifest` desired-state model — services, dependency graph, and routing table, cross-service constraints validated (`scanFleet`) |
| `@insler/platform/generator`   | The pluggable, deterministic codegen engine (`createGenerator`) and the shipped artifact plugins: Kubernetes manifests, autoscaling, edge routing, secret bindings, NATS credentials, data-store claims, serverless |
| `@insler/platform/reconciler`  | The plan/diff engine (`createReconciler`) behind the `StateProvider` seam, plus the apply policies: dev auto-converge, gated + audited production applies, and the continuous drift control loop |

### The CLI — `@insler/cli` ([`cli/`](./cli/README.md))

platform has no adapter packages — it binds no third-party system or format.
Its published sibling is the `insler` CLI, the composition layer at the top
of the stack:

| Package       | Purpose                                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `@insler/cli` | The `insler` binary — `scan`, `generate`, `plan`, `apply`, and `dev`, each also exported programmatically (`runScan`, `runGenerate`, …) with injectable IO |

## Where to go next

- [platform.insler.dev](https://platform.insler.dev) — getting started and the
  full docs for every layer and every CLI command.
- [`platform/README.md`](./platform/README.md) — the umbrella package's
  complete API walkthrough; [`cli/README.md`](./cli/README.md) — the binary's
  command reference.
- The declarations this subsystem compiles are authored with the
  [service subsystem](https://service.insler.dev) (`@insler/service`), whose
  contracts come from the [rpc subsystem](https://rpc.insler.dev)
  (`@insler/rpc`).
