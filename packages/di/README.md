# di — Typed dependency injection for TypeScript

Declare your application's pieces as typed **tokens**, bind each one with a factory in a
**container**, and let the container resolve the graph: independent bindings in parallel, every
value fully typed at the point of use, no decorators and no reflection. Pair a value with its
cleanup via the **managed** lifecycle and shutdown runs in reverse dependency order; wrap a
factory in **singleton** to share reference-counted resources across containers. di is fully
standalone — it depends on nothing else in this repo.

**Full documentation: [di.insler.dev](https://di.insler.dev)**

## Install

One install yields a working typed container — tokens, the container builder, and the lifecycle
primitives ship together in the single-entrypoint package:

```sh
bun add @insler/di
```

Its runtime dependencies are exactly `debug` and `object-hash` — nothing heavier.

## A minimal container

```ts
import { container, managed, token } from '@insler/di';

const Path = token<string>('path');
const Log = token<{ write(line: string): void }>('log');

const app = await container()
  .provide(Path, () => '/tmp/app.log')
  .provide(Log, [Path], (path) => {
    const sink = Bun.file(path).writer();
    return managed(
      { write: (line: string) => void sink.write(`${line}\n`) },
      async () => void (await sink.end())
    );
  })
  .start();

app.get(Log).write('hello'); // fully typed — no casts, no lookups by string
await app.stop(); // cleanups run in reverse dependency order
```

Beyond `provide`, the builder composes: `.use()` applies packs and `module()` definitions,
`.factory()` + parameterized/lazy tokens create whole families of instances from one factory,
`inject()` returns a deps-bound callable, `.defer()`/`.init()`/`.link()` cover dynamic
registration, post-start initialization, and ordering rules, and `.manifest()` prints the
dependency graph before anything starts.

## What's in this directory

### The umbrella package — `@insler/di` ([`di/`](./di/README.md))

di is a single-entrypoint core: the root import is the whole public surface.

| Entrypoint   | Purpose                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `@insler/di` | The typed container: token API (`token`, `factoryToken`, `parameterizedToken`, `lazyToken`), the `container()` builder (`provide`/`factory`/`lazy`/`use`/`defer`/`init`/`link`/`manifest`), lifecycle primitives (`managed`, `singleton`), and composition sugar (`module`, `inject`) |

### Adapter packages

None — di has no adapter packages. It exists to wire *your* dependencies, not to bind a
third-party system, so the subsystem is the one package above. (Composing other subsystems —
e.g. RPC transports and hosts as tokens — belongs in the consuming application, never in di
itself.)

## Where to go next

- [di.insler.dev](https://di.insler.dev) — getting started and the full docs for the container,
  token families, lifecycle, and composition patterns.
- [`di/README.md`](./di/README.md) — the package's complete API walkthrough.
- Building services? di composes cleanly with the rest of the family — see the
  [rpc subsystem](https://rpc.insler.dev) (`@insler/rpc`) and the
  [service subsystem](https://service.insler.dev) (`@insler/service`) — while staying fully
  independent of them.
