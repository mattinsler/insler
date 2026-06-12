---
title: '@insler/di'
description: The full public surface of the single-entrypoint di umbrella — tokens, the container builder, lifecycle primitives, and composition sugar.
sidebar:
  order: 1
---

di is a **single-entrypoint core**: the root `@insler/di` import is the whole
public surface. It is standalone — no dependency on the RPC stack or any
other subsystem — and its runtime dependencies are exactly `debug` and
`object-hash`.

```sh
bun add @insler/di
```

## The token API

Tokens are typed keys. The container resolves each one to exactly its
declared type — no casts, no string lookups.

- `token<T>(name)` / `token<T, C>(name, config)` — a basic token, optionally
  carrying typed configuration readable at `token.config`.
- `factoryToken<T, Config>(name)` — declares a **family**: one creation
  recipe serving many instances.
- `parameterizedToken<T, C>(name, parameter, config)` — an eager instance of
  a family. The parameter is hashed into the instance name; all instances
  share the family's `baseName` and route to its factory.
- `lazyToken<T, C>(name, parameter, config)` — a lazy instance: materialized
  on demand via `app.resolve(...)` after start, not eagerly during it.
- Type helpers: `Token`, `AnyToken`, `LazyToken`, `InferToken`,
  `InferTokens`, `AnyDeps`.

```ts
import { factoryToken, lazyToken, parameterizedToken, token } from '@insler/di';

const Port = token<number>('port');
const Conn = factoryToken<Connection, { host: string }>('conn');
const primary = parameterizedToken<Connection, { host: string }>('conn', 'primary', {
  host: 'primary.db',
});
const reporting = lazyToken<Connection, { host: string }>('conn', 'reporting', {
  host: 'reporting.db',
});
```

## The container builder

`container()` returns a `ContainerBuilder`; `.start()` resolves the graph
(independent bindings in parallel) and returns a `ResolvedContainer`.

- `.provide(token, factory)` / `.provide(token, deps, factory)` — bind a
  token. `deps` is an array (positional arguments) or a record (one typed
  object); factories may be async.
- `.factory(familyToken, metaFactory)` — register the creation recipe for a
  family. The meta-factory receives each instance's config and returns the
  instance factory — or `{ deps, factory }` / a `withDeps(...)` wrapper to
  declare per-instance dependencies.
- `.lazy(token, factory)` — register an on-demand binding directly.
- `.use(pack)` — apply a pack (a `(builder) => builder` function): the
  composition seam everything else sugars over.
- `.defer(async (builder) => ...)` — asynchronous registration before start
  (dynamic imports, discovered plugins, conditional bindings).
- `.init(async (resolved) => ...)` — run after all bindings resolve, before
  `.start()` returns. If an initializer throws, the container stops itself.
- `.link(rule)` — add **ordering-only** dependencies (`afterDeps`): the rule
  inspects each binding's `{ name, deps, hasBinding }` and may return names
  that must resolve first. No value is passed.
- `.manifest()` — introspect without starting: `bindings`, `levels`,
  `factories`, `unresolved`, `initializerCount`, `deferredCount`, plus
  `toString()` and `tree(name)` renderings.

Registration is **first-registration-wins**: later bindings for an
already-bound token back off. The dev/prod swap is built on exactly that —
apply the selected infra pack first, then the defaults.

## The resolved container

- `app.get(token)` — synchronous, eager tokens only (a lazy token is a
  compile error here).
- `app.resolve(lazyToken)` — materialize a lazy instance on demand.
- `app.resolveAll(deps)` — resolve a single token, a tuple, or a record of
  tokens in one call.
- `app.stop()` — run managed cleanups in reverse dependency order.

## Lifecycle primitives

- `managed(value, cleanup)` — pair a value with its cleanup; dependents see
  the plain value, and `stop()` runs cleanups dependents-first. `Managed` and
  `isManaged` are exported for advanced composition.
- `singleton(factory)` — wrap a factory so every caller shares one
  reference-counted instance across containers; cleanup fires when the last
  reference releases, and the next use after that creates a fresh instance.
  The production pattern combines all three: a `factory` whose instances are
  `singleton`-backed `managed` values.

## Composition sugar

Both helpers are **pure sugar** over `provide`/`use`/tokens — they add no
resolution semantics and never bypass first-registration-wins.

- `module(build)` — packages the pack + configure pattern into a callable,
  configurable definition unit. A module is **always called** — `.use(mod())`
  or `.use(mod({ ...config }))` — never passed bare. Config can carry `Pack`s,
  so plugin lists fall out for free. Types: `Module<Config>`, `Pack`.
- `inject(deps, fn)` — deps-bound partial application: returns a `BoundToken`
  whose value is `fn` with its first parameter bound to the resolved deps
  (shape mirrors `provide`: single token, tuple, or record). Register it with
  a **bare** `provide(boundToken)` — it resolves eagerly, so `get` returns
  the callable synchronously. A plain token without a factory does not
  type-check in that overload; treat a `BoundToken` as opaque.

```ts
import { container, inject, module, token } from '@insler/di';

const Url = token<string>('url');
const database = module((b, cfg: { url: string }) => b.provide(Url, () => cfg.url));

const sendEmail = inject({ smtp: Smtp }, ({ smtp }, to: string, body: string) =>
  smtp.send(to, body)
);

const app = await container()
  .use(database({ url: 'postgres://localhost' }))
  .provide(Smtp, () => createSmtp())
  .provide(sendEmail)
  .start();

app.get(sendEmail)('a@b.com', 'hi');
```

## Use it well

- Prefer `managed`/`singleton` over hand-rolled lifecycle wiring; never
  mutate a started container.
- Inspect `.manifest()` (especially `unresolved`) in a test before shipping a
  composition.
- Keep di out of library internals: composing other subsystems (transports,
  hosts, clients as tokens) belongs in the consuming application — coupling
  flows consumer → libraries, never into di.
