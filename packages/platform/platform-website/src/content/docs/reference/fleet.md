---
title: '@insler/platform/fleet'
description: Convention-based discovery of defineService declarations and the FleetManifest desired-state model — services, dependency graph, and routing table, cross-service constraints validated.
sidebar:
  order: 1
---

The scanner and the desired-state model. `scanFleet(options?)` walks a tree,
imports candidate declaration files (default `**/*.service.ts` /
`**/*.def.ts`), collects every exported `ServiceDef`, and folds them into a
`FleetManifest` — adding a service to the fleet is one new declaration file,
no edits elsewhere.

```ts
import { scanFleet } from '@insler/platform/fleet';

const result = await scanFleet({ cwd: './services' });
if (result.manifest) {
  result.manifest.services; // every declaration, live contracts intact
  result.manifest.graph.edges; // { from, to, type: 'calls' | 'needs' }
  result.manifest.expose.routes; // the fleet-wide routing table
}
```

## The manifest — three projections

`FleetManifest` projects the scanned declarations three ways:

- **`services`** — the raw `ServiceDef`s in discovery order, live contracts
  intact. This is the source of truth the other two derive from.
- **`graph.edges`** — one edge per declared relationship: a `calls` edge
  resolves to the *producing service's name* by subject; a `needs` edge
  targets the logical resource name.
- **`expose.routes`** — the fleet-wide external routing table, each route
  tagged with its owning service.

## Validation — cross-service only

Per-service validation happens inside `defineService` at declaration time;
the fleet layer validates only what no single declaration can see:
cross-fleet name and identity uniqueness, duplicate expose routes, and
unknown call subjects. `FleetResult.manifest` is present **only when
`errors` is empty** — never derive artifacts from an invalid fleet. Every
`FleetError` carries its `kind` and the implicated source `files`, so tools
report locations.

A matched file that exports no `ServiceDef` is skipped silently — broad scan
patterns are safe. Override discovery via `ScanOptions.patterns` / `ignore`
rather than post-filtering, and use `discoverServices` alone when you need to
inspect what was found before manifest validation; `buildFleetManifest` is
the pure fold over its output.

## Boundaries

This entrypoint depends only on `@insler/service` (the declaration model);
the dependency never reverses. The `FleetManifest` *model* is the stable
surface the [generator](/reference/generator/) and
[reconciler](/reference/reconciler/) consume — they never import the
scanner, so a caller may bring a manifest built any way they like (partial
adoption). Codegen does not belong here: the scanner only collects and
validates intent, staying fast enough to run on every change in development.
