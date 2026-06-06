# @insler/di

A lightweight, type-safe dependency injection container for TypeScript with support for:

- Typed tokens with configuration
- Factory and parameterized tokens
- Lazy (on-demand) resolution
- Managed lifecycle with graceful shutdown
- Singleton resource sharing with reference counting
- Parallel resolution of independent dependencies
- Link rules for implicit ordering constraints
- Deferred registration and post-start initialization

## Install

```sh
bun add @insler/di
```

## Tokens

Tokens are typed keys that identify dependencies in the container.

### Basic tokens

```ts
import { token } from '@insler/di';

const DbUrl = token<string>('dbUrl');
const Port = token<number>('port');
```

### Tokens with configuration

A token can carry typed configuration metadata via its second type parameter. The config is accessible at `token.config`.

```ts
function collection<T>(name: string) {
  return token<Map<string, T>, string>(`collection:${name}`, name);
}

const Users = collection<User>('users');
const Posts = collection<Post>('posts');

// Later, use the config to drive binding logic
container()
  .provide(Users, [Conn], (conn) => conn.collection(Users.config))
  .provide(Posts, [Conn], (conn) => conn.collection(Posts.config));
```

### Factory tokens

Factory tokens define a family of dependencies that share the same creation logic but differ by configuration.

```ts
import { factoryToken, parameterizedToken } from '@insler/di';

const DbConnection = factoryToken<Connection, { host: string }>('db');

const primaryDb = parameterizedToken<Connection>('db', 'primary', { host: 'primary.db' });
const replicaDb = parameterizedToken<Connection>('db', 'replica', { host: 'replica.db' });
```

### Lazy tokens

Lazy tokens are resolved on-demand after the container starts, rather than eagerly during startup. Use them with `factoryToken` to create instances that are only materialized when requested.

```ts
import { lazyToken } from '@insler/di';

const CacheFactory = factoryToken<CacheClient, { region: string }>('cache');

const usEast = lazyToken<CacheClient>('cache', 'us-east', { region: 'us-east' });
const euWest = lazyToken<CacheClient>('cache', 'eu-west', { region: 'eu-west' });
```

### Lazy token generator functions

A common pattern is to create a helper function that generates lazy tokens with the correct types:

```ts
const DbFactory = factoryToken<Database, string[]>('db');

function db(schemas: string[]) {
  return lazyToken<Database, string[]>(DbFactory.name, schemas);
}

const usersDb = db(['users']);
const ordersDb = db(['orders']);
const combinedDb = db(['users', 'orders']);
```

Each call produces a unique token (the parameter is hashed into the name), sharing the same `baseName` so the container routes them all to the same factory.

## Container

### Basic usage

```ts
import { container, token } from '@insler/di';

const Port = token<number>('port');
const Host = token<string>('host');
const Url = token<string>('url');

const app = await container()
  .provide(Port, () => 8080)
  .provide(Host, () => 'localhost')
  .provide(Url, { host: Host, port: Port }, ({ host, port }) => `${host}:${port}`)
  .start();

app.get(Url); // 'localhost:8080'

await app.stop();
```

### Array dependencies

```ts
const Sum = token<number>('sum');
const A = token<number>('a');
const B = token<number>('b');

container()
  .provide(A, () => 3)
  .provide(B, () => 4)
  .provide(Sum, [A, B], (a, b) => a + b);
```

### Record dependencies

```ts
const Greeting = token<string>('greeting');
const Name = token<string>('name');
const Prefix = token<string>('prefix');

container()
  .provide(Name, () => 'World')
  .provide(Prefix, () => 'Hello')
  .provide(Greeting, { name: Name, prefix: Prefix }, ({ name, prefix }) => `${prefix}, ${name}!`);
```

### Async factories

Factories can be async. The container resolves independent bindings in parallel.

```ts
const Db = token<Database>('db');
const Cache = token<CacheClient>('cache');
const App = token<Application>('app');

// Db and Cache resolve in parallel since they have no interdependency
container()
  .provide(Db, async () => connectToDatabase())
  .provide(Cache, async () => connectToCache())
  .provide(App, { db: Db, cache: Cache }, ({ db, cache }) => new Application(db, cache));
```

## Factories

Register a factory to create multiple instances from the same base token with different configurations.

```ts
import { container, token, factoryToken, parameterizedToken } from '@insler/di';

const DbConnection = factoryToken<Connection, { host: string }>('db');

container()
  .factory(DbConnection, (config) => () => createConnection(config.host));
```

Instances are created when referenced as dependencies:

```ts
const primary = parameterizedToken<Connection>('db', 'primary', { host: 'primary.db' });
const replica = parameterizedToken<Connection>('db', 'replica', { host: 'replica.db' });
const App = token<string>('app');

const app = await container()
  .factory(DbConnection, (config) => () => createConnection(config.host))
  .provide(App, [primary, replica], (p, r) => new App(p, r))
  .start();
```

### Factories with dependencies

Factories can declare their own dependencies. The metaFactory returns `{ deps, factory }`:

```ts
const Logger = token<Logger>('logger');

container()
  .provide(Logger, () => new Logger())
  .factory(DbConnection, (config) => ({
    deps: [Logger],
    factory: (logger) => createConnection(config.host, logger),
  }));
```

Or declare deps on the factory registration itself:

```ts
container()
  .provide(Logger, () => new Logger())
  .factory(DbConnection, [Logger], (config) => (logger) => createConnection(config.host, logger));
```

### Factories with config-derived dependencies

The config passed to a factory can carry token references, enabling dynamic dependency resolution per instance:

```ts
const OptionsA = token<ConnectionOptions>('options-a');
const OptionsB = token<ConnectionOptions>('options-b');

const ConnFactory = factoryToken<Connection, { optionsToken: Token<ConnectionOptions> }>('conn');

const connA = parameterizedToken<Connection>('conn', 'a', { optionsToken: OptionsA });
const connB = parameterizedToken<Connection>('conn', 'b', { optionsToken: OptionsB });

container()
  .provide(OptionsA, () => ({ host: 'primary' }))
  .provide(OptionsB, () => ({ host: 'replica' }))
  .factory(ConnFactory, ({ optionsToken }) =>
    withDeps([optionsToken], (opts) => createConnection(opts))
  );
```

### Factory + singleton + managed

The most common production pattern combines all three: a factory creates parameterized instances, each backed by a singleton with managed lifecycle:

```ts
const Provider = token<DbProvider>('provider');
const DbFactory = factoryToken<Database, string[]>('db');

container()
  .provide(Provider, () => createProvider())
  .factory(DbFactory, [Provider], (schemas) =>
    singleton(async (provider) => {
      const db = await provider.connect(schemas);
      return managed(db, () => db.close());
    })
  );
```

## Managed lifecycle

Return a `managed()` value to provide both a value and a cleanup function.

```ts
import { container, token, managed } from '@insler/di';

const Db = token<Database>('db');

const app = await container()
  .provide(Db, async () => {
    const conn = await connect('postgres://localhost');
    return managed(conn, async () => {
      await conn.close();
    });
  })
  .start();

app.get(Db); // the Database connection

await app.stop(); // calls conn.close()
```

Stop callbacks run in reverse dependency order — dependents shut down before their dependencies.

## Lazy resolution

Use `lazy()` on the builder to register factories that are resolved on-demand after startup.

```ts
const ExpensiveService = token<Service>('expensive');

const app = await container()
  .lazy(ExpensiveService, async () => createExpensiveService())
  .start();

// Resolved only when needed
const svc = await app.resolve(lazyToken<Service>('expensive', 'instance'));
```

Lazy registrations can also declare dependencies:

```ts
const Config = token<AppConfig>('config');
const LazyWorker = token<Worker>('worker');

container()
  .provide(Config, () => loadConfig())
  .lazy(LazyWorker, [Config], (config) => new Worker(config));
```

You can also resolve lazy tokens that use `factoryToken`:

```ts
const CacheFactory = factoryToken<CacheClient, { region: string }>('cache');
const usEast = lazyToken<CacheClient>('cache', 'us-east', { region: 'us-east' });

const app = await container()
  .factory(CacheFactory, (config) => async () => connectCache(config.region))
  .start();

const cache = await app.resolve(usEast); // created on demand
```

### resolveAll

Resolve multiple tokens at once:

```ts
// Single token
const val = await app.resolveAll(MyToken);

// Array of tokens
const [a, b] = await app.resolveAll([TokenA, TokenB]);

// Record of tokens
const { db, cache } = await app.resolveAll({ db: DbToken, cache: CacheToken });
```

## Singleton

Wrap a factory with `singleton()` to share a single instance across multiple containers, with reference-counted cleanup.

```ts
import { singleton, managed } from '@insler/di';

const createSharedPool = singleton(async () => {
  const pool = await createPool();
  return managed(pool, async () => pool.close());
});

// Both containers share the same pool
const app1 = await container()
  .provide(Pool, () => createSharedPool())
  .start();

const app2 = await container()
  .provide(Pool, () => createSharedPool())
  .start();

// Pool stays alive until both containers stop
await app1.stop(); // decrements refcount
await app2.stop(); // refcount hits 0, pool.close() is called
```

After all references are released, the next container that uses the singleton will trigger a fresh creation.

## Composition with use()

Break your container into composable modules (packs):

```ts
function databaseModule(builder: ContainerBuilder) {
  return builder
    .provide(DbUrl, () => 'postgres://localhost')
    .provide(Db, [DbUrl], (url) => connect(url));
}

function cacheModule(builder: ContainerBuilder) {
  return builder.provide(Cache, () => createCache());
}

const app = await container()
  .use(databaseModule)
  .use(cacheModule)
  .provide(App, { db: Db, cache: Cache }, ({ db, cache }) => new Application(db, cache))
  .start();
```

### Configure pattern

Use a `configure` wrapper to swap infrastructure implementations:

```ts
function devInfra(c: ContainerBuilder) {
  return c
    .provide(KV, () => managed(new InMemoryKV(), async () => {}))
    .provide(Events, () => new InMemoryBus());
}

function prodInfra(c: ContainerBuilder) {
  return c
    .provide(KV, async () => managed(await connectRedis(), async () => {}))
    .provide(Events, async () => managed(await connectNats(), async () => {}));
}

const Infra = {
  dev: devInfra,
  prod: prodInfra,
  configure: (source: (c: ContainerBuilder) => ContainerBuilder) => source,
};

// Swap by changing one argument
const app = await container()
  .use(Infra.configure(Infra.dev))
  .use(appModule)
  .start();
```

### Pack with helpers

Use `Object.assign` to attach helper methods to a pack function:

```ts
const DevPack = Object.assign(
  (c: ContainerBuilder) =>
    c
      .use(Infra.configure(Infra.dev))
      .use(DatabaseFactories)
      .use(ServiceFactories)
      .init(async (resolved) => {
        const transport = await resolved.resolve(clientTransport);
        await transport.discover();
      }),
  {
    withJobExecution: ({ temporalAddress }: { temporalAddress: string }) =>
      (c: ContainerBuilder) =>
        c.provide(TemporalClient, async () => {
          const conn = await connect({ address: temporalAddress });
          return managed(new Client({ connection: conn }), () => conn.close());
        }),
  }
);

// Use the base pack, optionally with extras
const app = await container()
  .use(DevPack)
  .use(DevPack.withJobExecution({ temporalAddress: 'localhost:7233' }))
  .start();
```

### module()

`module()` packages the pack + `configure` patterns above into a single named export a library can hand
out. It is pure currying over `provide`/`use`/tokens — it registers nothing itself and adds no resolution
semantics. A `module` is **always called** to produce a `Pack`; never passed bare to `.use`.

```ts
import { module, type Pack } from '@insler/di';

// configurable module — config type is inferred from the build function
const database = module((b, cfg: { url: string }) =>
  b.provide(DbUrl, () => cfg.url).provide(Db, [DbUrl], (url) => connect(url))
);
container().use(database({ url: 'postgres://localhost' }));

// no-config module — still called with no args
const cache = module((b) => b.provide(Cache, () => createCache()));
container().use(cache());

// plugins fall out for free: let the config carry packs
const http = module((b, { plugins = [] }: { plugins?: Pack[] }) =>
  plugins.reduce((acc, p) => acc.use(p), b.provide(Server, () => createServer()))
);
container().use(http({ plugins: [corsPlugin, authPlugin] }));
```

The dev/prod swap rides on first-registration-wins: apply the selected infra module's pack **first** so it
claims the shared tokens, then apply the defaults — the later registrations back off.

```ts
const devInfra = module((b) => b.provide(Db, () => inMemoryDb()));
const defaults = module((b) => b.provide(Db, () => connect(prodUrl)));

const configure = (env: 'dev' | 'prod') =>
  env === 'dev' ? container().use(devInfra()).use(defaults()) : container().use(defaults());
```

`Pack` (the type of what `.use` consumes) and `Module<Config>` are exported for annotating your own
modules and plugin lists. Both are typed against the base `ContainerBuilder`; the `Object.assign` helper
pack pattern above (which widens the builder with extra methods) stays hand-written rather than going
through `module()`.

## inject()

`inject()` binds dependency tokens to a function's **first parameter**, returning a token that resolves
to the partially-applied function — dependency-injected partial application. The library author writes
the logic and declares its deps; the consumer resolves a ready-to-call function with the remaining
parameters still free.

```ts
import { inject } from '@insler/di';

const sendEmail = inject(
  { smtp: Smtp, log: Logger },
  ({ smtp, log }, to: string, body: string) => {
    log.info('sending', to);
    return smtp.send(to, body);
  }
);

const app = await container()
  .provide(Smtp, () => createSmtp())
  .provide(Logger, () => createLogger())
  .provide(sendEmail) // a bound token registers with no extra arguments
  .start();

app.get(sendEmail)('a@b.com', 'hi'); // (to, body) => result — deps already bound
```

The dependency shape mirrors `provide`, and the first parameter follows it:

- **single token** → first parameter is the resolved value.
- **array/tuple of tokens** → first parameter is the resolved tuple.
- **record of tokens** → first parameter is the resolved object.

`inject()` is pure sugar over `provide` — no new resolution behavior. It resolves **eagerly**, so
`app.get(token)` returns the callable synchronously. Each call produces a `BoundToken` with a unique
identity; the token carries its own deps + factory, which is why `provide(boundToken)` takes no extra
arguments (and, by the same branding, a plain token with no factory won't type-check).

## Deferred registration

Register bindings asynchronously before the container starts. Useful for dynamic imports and conditional registration:

```ts
const app = await container()
  .defer(async (builder) => {
    const plugins = await discoverPlugins();
    for (const plugin of plugins) {
      plugin.register(builder);
    }
  })
  .start();
```

A common pattern uses defer to conditionally register seeding tasks:

```ts
function seed(getDescriptor: () => Promise<SchemaDescriptor>) {
  return (c: ContainerBuilder) =>
    c.defer(async (builder) => {
      const descriptor = await getDescriptor();
      if (descriptor.hasSeedFactory()) {
        const dbToken = db(descriptor);
        const seedToken = parameterizedToken<void>('seed', descriptor);
        builder.provide(seedToken, [dbToken], async (db) => {
          await descriptor.seed(db);
        });
      }
    });
}
```

## Initialization

Run code after all bindings resolve but before the container is returned:

```ts
const app = await container()
  .provide(Db, () => connect())
  .init(async (resolved) => {
    const db = resolved.get(Db);
    await db.migrate();
  })
  .start();
```

Init callbacks can also resolve lazy tokens for post-startup setup:

```ts
container()
  .factory(TransportFactory, (config) => () => createTransport(config))
  .init(async (resolved) => {
    const transport = await resolved.resolve(clientTransport);
    await transport.discover();
  });
```

If an initializer throws, the container is automatically stopped.

## Link rules

Add implicit ordering constraints between bindings. Link rules run after all bindings are registered and can inspect the dependency graph to add `afterDeps` — ordering dependencies that don't pass values but ensure resolution order.

### Auto-seeding databases

Ensure seed tasks run before any binding that depends on the corresponding database:

```ts
const DB_PREFIX = 'db:';
const SEED_PREFIX = 'seed:';

container()
  .use(DatabaseFactories)
  .link(({ name, deps, hasBinding }) => {
    if (name.startsWith(SEED_PREFIX)) return;
    const seeds: string[] = [];
    for (const dep of deps) {
      if (!dep.startsWith(DB_PREFIX)) continue;
      const seed = SEED_PREFIX + dep.slice(DB_PREFIX.length);
      if (hasBinding(seed)) seeds.push(seed);
    }
    if (seeds.length > 0) return seeds;
  });
```

### Auto-requiring hosted services

Ensure a hosted service is started before its client becomes available:

```ts
const CLIENT_PREFIX = 'service-client:';
const HOSTED_PREFIX = 'hosted-service:';

container()
  .use(ServiceFactories)
  .link(({ name, hasBinding }) => {
    if (!name.startsWith(CLIENT_PREFIX)) return;
    const serviceId = name.slice(CLIENT_PREFIX.length);
    const hosted = HOSTED_PREFIX + serviceId;
    if (hasBinding(hosted)) return [hosted];
  });
```

## Container manifest

Inspect the container's dependency graph without starting it:

```ts
const builder = container()
  .provide(A, () => 'a')
  .provide(B, [A], (a) => a)
  .provide(C, [A, B], (a, b) => `${a}${b}`);

const manifest = builder.manifest();

// Print the full manifest
console.log(manifest.toString());

// Print a dependency tree for a specific binding
console.log(manifest.tree('c'));
// c
// ├── a
// └── b
//     └── a

// Inspect programmatically
manifest.bindings;        // all bindings with their deps
manifest.levels;          // bindings grouped by resolution level
manifest.factories;       // registered factories
manifest.unresolved;      // deps that have no binding
manifest.initializerCount;
manifest.deferredCount;
```

## withDeps helper

A convenience function for creating `{ deps, factory }` pairs, useful with `factory()`:

```ts
import { withDeps } from '@insler/di';

container().factory(ServiceFactory, (config) =>
  withDeps([Logger, Config], (logger, cfg) => createService(config, logger, cfg))
);
```

## License

MIT
