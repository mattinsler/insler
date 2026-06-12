# @insler/cli

The `insler` binary — the full-adoption layer that composes the platform
libraries behind a single command-line tool.

It exposes `insler scan` (over `@insler/platform/fleet`), `insler generate` (over
`@insler/platform/generator`), `insler plan` / `insler apply` (over `@insler/platform/reconciler`),
and `insler dev` (the development auto-converge inner loop). The package is kept
thin: it is command wiring, not platform logic.

## Usage

```sh
insler scan [dir] [--json]
```

Scans `dir` (default: the current directory) for service declarations, builds
the fleet manifest, and reports the result:

- a valid fleet prints a summary (or the full manifest as JSON with `--json`)
  and exits `0`;
- an invalid fleet prints each error with its source file location(s) and exits
  `1`.

```sh
$ insler scan src
Discovered 2 service(s):
  - orders (persistent)
  - checkout (ephemeral)
Graph: 3 edge(s)
Exposed routes: 2
```

The command logic is also exported programmatically (`runScan`) with injectable
I/O for embedding and testing.

## Generating artifacts

```sh
insler generate [dir] [--out <dir>] [--target kubernetes|serverless] [--env <name>] [--dry-run]
```

Scans `dir`, builds the fleet manifest, and runs the generator's plugins over it,
writing the deployment artifacts under `--out` (default `./out`). `--dry-run`
prints the artifacts to stdout and writes nothing.

## Plan and apply

```sh
insler plan  [dir] [--state <file>] [--env <name>] [--comment]
insler apply [dir] [--state <file>] [--env <name>] [--dry-run] [--audit <file>] [--operator <id>]
```

`insler plan` diffs the generated desired state against the actual state (a JSON
snapshot behind `--state`) and prints the reviewable plan; `--comment` emits a
Markdown CI/PR comment with the blast radius up front instead.

`insler apply` executes the plan, converging actual state to desired. With
`--env production` the apply is **gated and audited**: a stale plan (actual state
moved since planning) is rejected, and every attempt — applied or rejected — is
appended to the JSONL audit trail at `--audit` (default `./insler-audit.jsonl`)
attributed to `--operator` (default `$INSLER_OPERATOR` or `$USER`).

## Development auto-converge

```sh
insler dev [dir] [--state <file>] [--env <name>]
```

The development inner loop. `insler dev` watches the service-declaration files
under `dir` (`*.service.ts` / `*.def.ts`) and, on every change, re-scans the
fleet, re-generates the deployment artifacts, diffs them against the current
state, and **auto-applies** the result — no plan review, no approval. Save a
declaration, see it converge.

This is the *ungated* counterpart to `insler apply --env production` (which gates
every change behind a reviewed plan and an audit trail). Because it applies
without review, `insler dev` is **development-only**: `--env production` is
refused outright and the watcher never starts.

```sh
$ insler dev src
Converged: 1 added, 0 changed, 0 destroyed.
# ...edit a declaration and save...
Converged: 0 added, 1 changed, 0 destroyed.
```

The orchestration lives in this composition layer; the engine stays scanner-free.
The auto-apply itself is the reconciler's ungated `applyAuto` primitive. The loop
is exported programmatically (`runDev`, `converge`, `watchDeclarations`) with an
injectable state-provider and file-watch seam for embedding and testing.
