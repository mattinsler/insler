# @insler/platform

The @insler ifc-platform in one package, with each layer importable as its own subpath
entrypoint:

| Entrypoint | Layer |
| --- | --- |
| `@insler/platform/fleet` | Scanner + desired-state model: discovers `defineService` declarations and folds them into a validated `FleetManifest` |
| `@insler/platform/generator` | Pluggable codegen engine: turns a `FleetManifest` into deterministic artifacts (kubernetes, serverless, edge routing, …) |
| `@insler/platform/reconciler` | Atlas-style plan/diff engine: diffs desired vs actual state, gates production applies, audits, and heals drift |

Each entrypoint is separately compiled — importing one loads no code from the others — and the
layer boundaries of ADR-0002 hold inside the package: generator and reconciler import only the
`FleetManifest` *model* from fleet, never its filesystem scanner, so partial adoption (bring your
own manifest) survives as subpath imports.

The root entrypoint re-exports the primary surface of all three layers; the subpaths are the
canonical import style.

The `insler` CLI composes these layers into commands (`scan`, `generate`, `plan`, `apply`, `dev`)
and stays a separate package: `@insler/cli`.
