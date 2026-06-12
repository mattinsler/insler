---
title: Getting started
description: From `bun add @insler/di` to a typed, managed container in minutes.
---

This guide takes you from one install to a working container — typed tokens,
factories with dependencies, managed cleanup, and shared resources.

## 1. Install

```sh
bun add @insler/di
```

That one package contains everything this guide uses: the token API, the
`container()` builder, and the lifecycle primitives. Its runtime dependencies
are exactly `debug` and `object-hash`.

## 2. Declare tokens

A **token** is a typed key. The type parameter is the contract: whatever
binds the token must produce that type, and whatever depends on it receives
that type.

```ts
import { token } from '@insler/di';

const DbUrl = token<string>('db-url');
const Db = token<Database>('db');
const App = token<Application>('app');
```

## 3. Bind and start

`.provide(token, deps, factory)` binds a token to a factory. Dependencies can
be positional (an array of tokens) or named (a record of tokens); the factory
receives them fully typed. Factories can be async — independent bindings
resolve in parallel.

```ts
import { container, managed } from '@insler/di';

const app = await container()
  .provide(DbUrl, () => 'postgres://localhost')
  .provide(Db, [DbUrl], async (url) => {
    const db = await Database.connect(url);
    return managed(db, async () => db.close());
  })
  .provide(App, { db: Db }, ({ db }) => new Application(db))
  .start();

app.get(App); // Application — fully typed
```

Returning `managed(value, cleanup)` pairs the value with its cleanup. When
you call `.stop()`, cleanups run in **reverse dependency order** — the
`Application` goes away before the `Database` connection it depends on.

```ts
await app.stop(); // app first, then db.close()
```

## 4. Share resources across containers

Wrap a factory in `singleton()` to share one instance across containers with
reference-counted cleanup — the resource is released only when the last
container holding it stops.

```ts
import { singleton } from '@insler/di';

const sharedPool = singleton(async () => {
  const pool = await createPool();
  return managed(pool, async () => pool.close());
});

const api = await container().provide(Pool, () => sharedPool()).start();
const worker = await container().provide(Pool, () => sharedPool()).start();

await api.stop(); // pool stays alive
await worker.stop(); // refcount hits 0 — pool.close() runs
```

## 5. Create families with factories

`factoryToken` registers one creation recipe; `parameterizedToken` and
`lazyToken` mint instances of the family — the parameter is hashed into each
instance's name, and they all route to the same factory. Lazy tokens
materialize on demand after start.

```ts
import { factoryToken, lazyToken, parameterizedToken } from '@insler/di';

const DbConn = factoryToken<Connection, { host: string }>('conn');
const primary = parameterizedToken<Connection, { host: string }>('conn', 'primary', {
  host: 'primary.db',
});
const reporting = lazyToken<Connection, { host: string }>('conn', 'reporting', {
  host: 'reporting.db',
});

const app = await container()
  .factory(DbConn, (config) => () => connect(config.host))
  .provide(App, [primary], (conn) => new Application(conn))
  .start();

await app.resolve(reporting); // created now, on demand
```

## 6. Inspect before you start

`.manifest()` exposes the dependency graph — bindings, resolution levels,
unresolved dependencies — without starting anything:

```ts
const manifest = container().use(infra()).use(appModule()).manifest();
console.log(manifest.tree('app'));
console.log(manifest.unresolved); // deps with no binding — catch them in a test
```

## Where to go next

- **Compose.** `.use()` packs, `module()` definition units, the dev/prod
  swap on first-registration-wins, and `inject()` for deps-bound callables —
  all in the [reference](/reference/di/).
- **Order without values.** `.defer()` for async registration, `.init()` for
  post-start setup, `.link()` for ordering-only dependencies.
- **Meet the family.** di is standalone, but it composes the rest of
  [insler.dev](https://insler.dev) cleanly — transports, hosts, and clients
  make natural tokens in *your* application.
