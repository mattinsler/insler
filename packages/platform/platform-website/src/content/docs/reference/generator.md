---
title: '@insler/platform/generator'
description: 'The pluggable, deterministic codegen engine: createGenerator plus the shipped artifact plugins — Kubernetes, autoscaling, edge routing, secret bindings, NATS credentials, data-store claims, serverless.'
sidebar:
  order: 2
---

The codegen engine. `createGenerator()` returns an artifact-agnostic
`Generator`; every concrete output is a `GeneratorPlugin` registered with
`.use(...plugins)` (chainable; duplicate plugin names are rejected):

```ts
import { autoscalerPlugin, createGenerator, kubernetesPlugin } from '@insler/platform/generator';

const generator = createGenerator().use(kubernetesPlugin, autoscalerPlugin);
const generation = generator.generate(manifest, {
  target: 'kubernetes', // or 'serverless'
  outputDir: 'deploy',
  environment: 'dev',
});

await generator.write(generation, 'deploy'); // the only I/O
generator.dryRun(generation, (line) => console.log(line));
generator.diff(previous.files, generation.files); // added / changed / removed / unchanged
```

## Determinism is load-bearing

A plugin's `generate(manifest, options)` must be **pure and deterministic** —
same manifest and options in, same files in the same order out: no I/O, no
timestamps, no randomness. The engine sorts files by path for stable diffs
and detects cross-plugin path collisions. This is what makes the
[reconciler](/reference/reconciler/)'s plan/diff meaningful: a diff over
nondeterministic output would be noise.

Every artifact derives from the `FleetManifest` — there are no hand-authored
values files. A plugin decides *what* to produce from the manifest; the
options say only *where and for what environment*.

## Shipped plugins

| Plugin | Produces |
| --- | --- |
| `kubernetesPlugin` | Workload manifests, including a RuntimeClass from each service's `effectiveIsolation` |
| `autoscalerPlugin` | KEDA ScaledObject / HPA from `effectiveScale` |
| `edgeRoutingPlugin` | The fleet-wide routing table, with cross-service path-uniqueness validation |
| `createSecretBindingPlugin(config)` | Secret bindings against a secret store |
| `natsCredentialsPlugin` | Identity-scoped pub/sub permissions |
| `dataStoreClaimsPlugin` | Data-store claims from each service's `needRefs` |
| `serverlessPlugin` + `cloudRunPlatform` | Serverless deployment artifacts |
| `fleetInventoryPlugin` | A fleet inventory file (the reference example plugin) |

Add a new artifact type as a new plugin registered with `.use(...)` — never
by widening the engine.

## Boundaries

Depends only on the `FleetManifest` *model* from
[`/fleet`](/reference/fleet/), never its filesystem scanner — bring a
manifest built any way you like. The `Generator.diff` here is the
*generated-output file diff* that feeds plan/diff; desired-vs-actual state
reconciliation lives in the [reconciler](/reference/reconciler/), which
consumes this entrypoint's output (never the reverse).
