import { test, expect, describe } from 'bun:test';

import { container, ContainerBuilder, withDeps } from './container.js';
import { managed } from './managed.js';
import { singleton } from './singleton.js';
import { token, factoryToken, parameterizedToken, lazyToken } from './token.js';

describe('Factory + singleton pattern', () => {
  test('factory with singleton shares instances across parameterized tokens', async () => {
    let createCount = 0;
    const DbFactory = factoryToken<string, { name: string }>('db');
    const usersDb = parameterizedToken<string, { name: string }>('db', 'users', { name: 'users' });
    const ordersDb = parameterizedToken<string, { name: string }>('db', 'orders', {
      name: 'orders',
    });
    const App = token<string>('app');

    const c = await container()
      .factory(DbFactory, (config) =>
        singleton(async () => {
          createCount++;
          return managed(`db:${config.name}`, async () => {});
        })
      )
      .provide(App, [usersDb, ordersDb], (u, o) => `${u}|${o}`)
      .start();

    expect(c.get(App)).toBe('db:users|db:orders');
    expect(createCount).toBe(2);
    await c.stop();
  });

  test('singleton factory shares one instance across multiple containers', async () => {
    let createCount = 0;
    let stopCount = 0;

    const Db = token<string>('db');
    const sharedDb = singleton(async () => {
      createCount++;
      return managed(`db-${createCount}`, async () => {
        stopCount++;
      });
    });

    const c1 = await container().provide(Db, sharedDb).start();
    const c2 = await container().provide(Db, sharedDb).start();

    expect(createCount).toBe(1);
    expect(c1.get(Db)).toBe('db-1');
    expect(c2.get(Db)).toBe('db-1');

    await c1.stop();
    expect(stopCount).toBe(0);

    await c2.stop();
    expect(stopCount).toBe(1);
  });

  test('singleton recreates after all references released', async () => {
    let createCount = 0;
    const Db = token<string>('db');
    const sharedDb = singleton(async () => {
      createCount++;
      return `db-${createCount}`;
    });

    const c1 = await container().provide(Db, sharedDb).start();
    expect(c1.get(Db)).toBe('db-1');
    await c1.stop();

    const c2 = await container().provide(Db, sharedDb).start();
    expect(c2.get(Db)).toBe('db-2');
    expect(createCount).toBe(2);
    await c2.stop();
  });
});

describe('Pack composition pattern', () => {
  test('modules compose via use() with configure pattern', async () => {
    const KV = token<Map<string, string>>('kv');
    const App = token<string>('app');

    function devKV(c: ContainerBuilder) {
      return c.provide(KV, () => managed(new Map<string, string>(), async () => {}));
    }

    function prodKV(c: ContainerBuilder) {
      return c.provide(KV, () => managed(new Map([['env', 'prod']]), async () => {}));
    }

    const Infra = {
      dev: devKV,
      prod: prodKV,
      configure: (source: (c: ContainerBuilder) => ContainerBuilder) => source,
    };

    const c = await container()
      .use(Infra.configure(Infra.prod))
      .provide(App, [KV], (kv) => `env:${kv.get('env')}`)
      .start();

    expect(c.get(App)).toBe('env:prod');
    await c.stop();
  });

  test('Object.assign pack with attached helpers', async () => {
    const Base = token<string>('base');
    const Extra = token<string>('extra');

    const MyPack = Object.assign((c: ContainerBuilder) => c.provide(Base, () => 'base-value'), {
      withExtra: (value: string) => (c: ContainerBuilder) => c.provide(Extra, () => value),
    });

    const c = await container().use(MyPack).use(MyPack.withExtra('extra-value')).start();

    expect(c.get(Base)).toBe('base-value');
    expect(c.get(Extra)).toBe('extra-value');
    await c.stop();
  });

  test('chain of packs composes full environment', async () => {
    const Config = token<{ env: string }>('config');
    const Db = token<string>('db');
    const Cache = token<string>('cache');
    const App = token<string>('app');

    function configPack(c: ContainerBuilder) {
      return c.provide(Config, () => ({ env: 'test' }));
    }

    function dbPack(c: ContainerBuilder) {
      return c.provide(Db, [Config], (cfg) => `db:${cfg.env}`);
    }

    function cachePack(c: ContainerBuilder) {
      return c.provide(Cache, [Config], (cfg) => `cache:${cfg.env}`);
    }

    const c = await container()
      .use(configPack)
      .use(dbPack)
      .use(cachePack)
      .provide(App, { db: Db, cache: Cache }, ({ db, cache }) => `${db}+${cache}`)
      .start();

    expect(c.get(App)).toBe('db:test+cache:test');
    await c.stop();
  });
});

describe('Token config as typed metadata', () => {
  test('token.config carries typed metadata through to bindings', async () => {
    function collection<T>(name: string) {
      return token<Map<string, T>, string>(`collection:${name}`, name);
    }

    const Users = collection<{ name: string }>('users');
    const Posts = collection<{ title: string }>('posts');

    const c = await container()
      .provide(Users, () => new Map())
      .provide(Posts, () => new Map())
      .start();

    expect(Users.config).toBe('users');
    expect(Posts.config).toBe('posts');

    c.get(Users).set('u1', { name: 'Alice' });
    c.get(Posts).set('p1', { title: 'Hello' });

    expect(c.get(Users).get('u1')).toEqual({ name: 'Alice' });
    expect(c.get(Posts).get('p1')).toEqual({ title: 'Hello' });
    await c.stop();
  });
});

describe('Factory + withDeps pattern', () => {
  test('factory metaFactory returns withDeps for dynamic dependency resolution', async () => {
    const Logger = token<string>('logger');
    const ServiceFactory = factoryToken<string, { name: string }>('service');
    const svcA = parameterizedToken<string, { name: string }>('service', 'a', { name: 'alpha' });
    const App = token<string>('app');

    const c = await container()
      .provide(Logger, () => 'logger')
      .factory(ServiceFactory, (config) =>
        withDeps([Logger], (logger) => `${config.name}[${logger}]`)
      )
      .provide(App, [svcA], (a) => `app(${a})`)
      .start();

    expect(c.get(App)).toBe('app(alpha[logger])');
    await c.stop();
  });

  test('factory with withDeps and singleton combines all patterns', async () => {
    let created = 0;
    const Provider = token<string>('provider');
    const DbFactory = factoryToken<string, string>('db');
    const dbA = parameterizedToken<string, string>('db', 'a', 'schema-a');
    const dbB = parameterizedToken<string, string>('db', 'b', 'schema-b');
    const App = token<string>('app');

    const c = await container()
      .provide(Provider, () => 'pg-provider')
      .factory(DbFactory, [Provider], (schema) =>
        singleton(async (provider) => {
          created++;
          return managed(`${provider}/${schema}`, async () => {});
        })
      )
      .provide(App, [dbA, dbB], (a, b) => `${a}|${b}`)
      .start();

    expect(c.get(App)).toBe('pg-provider/schema-a|pg-provider/schema-b');
    expect(created).toBe(2);
    await c.stop();
  });
});

describe('Lazy token via factoryToken pattern', () => {
  test('lazy tokens resolve on-demand through registered factory', async () => {
    let resolved: string[] = [];
    const ServiceFactory = factoryToken<string, { id: string }>('service');

    const svcA = lazyToken<string, { id: string }>('service', 'alpha', { id: 'alpha' });
    const svcB = lazyToken<string, { id: string }>('service', 'beta', { id: 'beta' });

    const c = await container()
      .factory(ServiceFactory, (config) => () => {
        resolved.push(config.id);
        return `svc:${config.id}`;
      })
      .start();

    expect(resolved).toEqual([]);

    const a = await c.resolve(svcA);
    expect(a).toBe('svc:alpha');
    expect(resolved).toEqual(['alpha']);

    const b = await c.resolve(svcB);
    expect(b).toBe('svc:beta');
    expect(resolved).toEqual(['alpha', 'beta']);

    await c.stop();
  });

  test('lazy token generator function creates unique tokens per parameter', async () => {
    const DbFactory = factoryToken<string, string[]>('db');

    function db(schemas: string[]) {
      return lazyToken<string, string[]>(DbFactory.name, schemas);
    }

    const usersDb = db(['users']);
    const ordersDb = db(['orders']);
    const combinedDb = db(['users', 'orders']);

    expect(usersDb.name).not.toBe(ordersDb.name);
    expect(usersDb.baseName).toBe('db');
    expect(ordersDb.baseName).toBe('db');
    expect(combinedDb.name).not.toBe(usersDb.name);
    expect(combinedDb.config).toEqual(['users', 'orders']);

    const c = await container()
      .factory(DbFactory, (schemas) => () => `db(${schemas.join(',')})`)
      .start();

    const [u, o, combo] = await c.resolveAll([usersDb, ordersDb, combinedDb]);
    expect(u).toBe('db(users)');
    expect(o).toBe('db(orders)');
    expect(combo).toBe('db(users,orders)');
    await c.stop();
  });
});

describe('Link rules for auto-wiring', () => {
  test('link rule auto-adds seed tasks before db consumers (postgres pattern)', async () => {
    const order: string[] = [];
    const DB_PREFIX = 'db:';
    const SEED_PREFIX = 'seed:';

    const dbUsers = parameterizedToken<string>('db', 'users');
    const seedUsers = parameterizedToken<void>('seed', 'users');
    const App = token<string>('app');

    const c = await container()
      .provide(dbUsers, () => {
        order.push('db:users');
        return 'db-connection';
      })
      .provide(seedUsers, [dbUsers], (_db) => {
        order.push('seed:users');
      })
      .provide(App, [dbUsers], (db) => {
        order.push('app');
        return `app(${db})`;
      })
      .link(({ name, deps, hasBinding }) => {
        if (name.startsWith(SEED_PREFIX)) return;
        const seeds: string[] = [];
        for (const dep of deps) {
          if (!dep.startsWith(DB_PREFIX)) continue;
          const seed = SEED_PREFIX + dep.slice(DB_PREFIX.length);
          if (hasBinding(seed)) seeds.push(seed);
        }
        if (seeds.length > 0) return seeds;
      })
      .start();

    expect(order.indexOf('db:users')).toBeLessThan(order.indexOf('seed:users'));
    expect(order.indexOf('seed:users')).toBeLessThan(order.indexOf('app'));
    await c.stop();
  });

  test('link rule auto-requires hosted service before client (service pattern)', async () => {
    const order: string[] = [];
    const CLIENT_PREFIX = 'client:';
    const HOSTED_PREFIX = 'hosted:';

    const hostedUsers = parameterizedToken<void>('hosted', 'users-v1');
    const clientUsers = parameterizedToken<string>('client', 'users-v1');

    const c = await container()
      .provide(hostedUsers, () => {
        order.push('hosted');
      })
      .provide(clientUsers, () => {
        order.push('client');
        return 'users-client';
      })
      .link(({ name, hasBinding }) => {
        if (!name.startsWith(CLIENT_PREFIX)) return;
        const serviceId = name.slice(CLIENT_PREFIX.length);
        const hosted = HOSTED_PREFIX + serviceId;
        if (hasBinding(hosted)) return [hosted];
      })
      .start();

    expect(order).toEqual(['hosted', 'client']);
    await c.stop();
  });
});

describe('Deferred registration with dynamic imports', () => {
  test('defer + provide registers bindings from async source', async () => {
    const A = token<string>('a');
    const B = token<string>('b');
    const App = token<string>('app');

    const c = await container()
      .defer(async (builder) => {
        await new Promise((r) => setTimeout(r, 5));
        builder.provide(A, () => 'deferred-a');
      })
      .defer(async (builder) => {
        builder.provide(B, () => 'deferred-b');
      })
      .provide(App, [A, B], (a, b) => `${a}+${b}`)
      .start();

    expect(c.get(App)).toBe('deferred-a+deferred-b');
    await c.stop();
  });

  test('defer can register factory-expanded tokens', async () => {
    const DbFactory = factoryToken<string, string>('db');
    const dbUsers = parameterizedToken<string, string>('db', 'users', 'users-schema');
    const App = token<string>('app');

    const c = await container()
      .factory(DbFactory, (schema) => () => `db:${schema}`)
      .defer(async (builder) => {
        const seedToken = parameterizedToken<void>('seed', 'users');
        builder.provide(seedToken, [dbUsers], (_db) => {});
      })
      .provide(App, [dbUsers], (db) => `app(${db})`)
      .start();

    expect(c.get(App)).toBe('app(db:users-schema)');
    await c.stop();
  });
});

describe('Init with lazy resolution', () => {
  test('init can resolve lazy tokens for post-startup setup', async () => {
    let discoveredServices: string[] = [];
    const TransportFactory = factoryToken<string, string>('transport');
    const transport = lazyToken<string, string>('transport', 'default', 'nats');

    const c = await container()
      .factory(TransportFactory, (config) => () => `transport:${config}`)
      .init(async (resolved) => {
        const t = await resolved.resolve(transport);
        discoveredServices.push(t);
      })
      .start();

    expect(discoveredServices).toEqual(['transport:nats']);
    await c.stop();
  });
});

describe('Factory with config-derived dependencies', () => {
  test('factory config can carry token references for dynamic deps', async () => {
    const OptionsA = token<string>('options-a');
    const OptionsB = token<string>('options-b');
    const ConnFactory = factoryToken<string, { optionsToken: typeof OptionsA }>('conn');

    const connA = parameterizedToken<string, { optionsToken: typeof OptionsA }>('conn', 'a', {
      optionsToken: OptionsA,
    });
    const connB = parameterizedToken<string, { optionsToken: typeof OptionsB }>('conn', 'b', {
      optionsToken: OptionsB,
    });
    const App = token<string>('app');

    const c = await container()
      .provide(OptionsA, () => 'opts-a')
      .provide(OptionsB, () => 'opts-b')
      .factory(ConnFactory, ({ optionsToken }) =>
        withDeps([optionsToken], (opts) => `conn(${opts})`)
      )
      .provide(App, [connA, connB], (a, b) => `${a}|${b}`)
      .start();

    expect(c.get(App)).toBe('conn(opts-a)|conn(opts-b)');
    await c.stop();
  });
});

describe('Full integration: multi-layer service architecture', () => {
  test('infrastructure → factories → services → app', async () => {
    const Provider = token<string>('provider');
    const DbFactory = factoryToken<string, string[]>('db');
    const ServiceFactory = factoryToken<string, { name: string }>('service');

    function db(schemas: string[]) {
      return lazyToken<string, string[]>(DbFactory.name, schemas);
    }

    function service(name: string) {
      return lazyToken<string, { name: string }>(ServiceFactory.name, name, { name });
    }

    const usersDb = db(['users']);
    const userService = service('users');

    function infraPack(c: ContainerBuilder) {
      return c.provide(Provider, () => 'pg');
    }

    function factoriesPack(c: ContainerBuilder) {
      return c
        .factory(DbFactory, [Provider], (schemas) =>
          singleton(async (prov) => {
            return managed(`${prov}:${schemas.join(',')}`, async () => {});
          })
        )
        .factory(ServiceFactory, (config) =>
          withDeps([db([config.name])], (dbConn) => `svc:${config.name}(${dbConn})`)
        );
    }

    const c = await container().use(infraPack).use(factoriesPack).start();

    const svc = await c.resolve(userService);
    expect(svc).toBe('svc:users(pg:users)');

    const dbConn = await c.resolve(usersDb);
    expect(dbConn).toBe('pg:users');

    await c.stop();
  });
});
