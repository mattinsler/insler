import { describe, expect, test } from 'bun:test';

import { expectTypeOf } from 'expect-type';

import { container } from './container.js';
import * as index from './index.js';
import { module } from './module.js';
import type { Module, Pack } from './module.js';
import { token } from './token.js';

const Url = token<string>('url');
const Cache = token<string>('cache');
const Server = token<string>('server');

describe('module() — public surface', () => {
  test('module is re-exported from the package index', () => {
    expect(index.module).toBe(module);
    // Pack / Module are type-only exports — exercised by the type tests below.
    expectTypeOf<index.Pack>().toEqualTypeOf<Pack>();
    expectTypeOf<index.Module<{ url: string }>>().toEqualTypeOf<Module<{ url: string }>>();
  });
});

describe('module() — runtime', () => {
  test('configurable module applies its config through .use()/.start()', async () => {
    const database = module((b, cfg: { url: string }) => b.provide(Url, () => cfg.url));

    const app = await container()
      .use(database({ url: 'postgres://db' }))
      .start();

    expect(app.get(Url)).toBe('postgres://db');
    await app.stop();
  });

  test('no-config module is invoked with no args', async () => {
    const cache = module((b) => b.provide(Cache, () => 'in-memory'));

    const app = await container().use(cache()).start();

    expect(app.get(Cache)).toBe('in-memory');
    await app.stop();
  });

  test('plugins ride on config-carrying packs (no extra API)', async () => {
    const order: string[] = [];
    const corsPlugin: Pack = (b) => b.provide(token<string>('cors'), () => 'cors');
    const authPlugin: Pack = (b) => b.provide(token<string>('auth'), () => 'auth');

    const http = module((b, { plugins = [] }: { plugins?: Pack[] }) =>
      plugins.reduce(
        (acc, p) => acc.use(p),
        b.provide(Server, () => {
          order.push('server');
          return 'server';
        })
      )
    );

    const app = await container()
      .use(http({ plugins: [corsPlugin, authPlugin] }))
      .start();

    expect(app.get(Server)).toBe('server');
    expect(app.get(token<string>('cors'))).toBe('cors');
    expect(app.get(token<string>('auth'))).toBe('auth');
    await app.stop();
  });

  test('dev/prod swap rides on first-registration-wins (pack selected first wins)', async () => {
    const Db = token<string>('db');
    // The default module provides a real DB; the selected infra module claims the token first.
    const defaults = module((b) => b.provide(Db, () => 'prod-db'));
    const devInfra = module((b) => b.provide(Db, () => 'dev-db'));

    const configure = (env: 'dev' | 'prod') =>
      env === 'dev' ? container().use(devInfra()).use(defaults()) : container().use(defaults());

    const dev = await configure('dev').start();
    const prod = await configure('prod').start();

    expect(dev.get(Db)).toBe('dev-db'); // dev pack ran first, claimed the token
    expect(prod.get(Db)).toBe('prod-db'); // only the default ran
    await dev.stop();
    await prod.stop();
  });

  test('module() is pure currying — it registers nothing until applied', () => {
    let built = 0;
    const m = module((b) => {
      built++;
      return b.provide(Cache, () => 'x');
    });

    // Creating the module and even producing a pack must not run the build.
    const pack = m();
    expect(built).toBe(0);

    // Only applying the pack to a builder runs the build.
    pack(container());
    expect(built).toBe(1);
  });
});

describe('module() — types', () => {
  test('config type is inferred and required for a configurable module', () => {
    const database = module((b, cfg: { url: string }) => b.provide(Url, () => cfg.url));

    expectTypeOf(database).parameters.toEqualTypeOf<[{ url: string }]>();
    expectTypeOf(database).returns.toEqualTypeOf<Pack>();

    // @ts-expect-error config is required
    database();
    // @ts-expect-error config shape is enforced
    database({ url: 123 });
  });

  test('no-config module takes no args', () => {
    const cache = module((b) => b.provide(Cache, () => 'in-memory'));

    expectTypeOf(cache).parameters.toEqualTypeOf<[]>();
    expectTypeOf(cache).returns.toEqualTypeOf<Pack>();

    // @ts-expect-error no-config module accepts no arguments
    cache({});
  });

  test('Module<Config> annotates an exported module', () => {
    const database: Module<{ url: string }> = module((b, cfg: { url: string }) =>
      b.provide(Url, () => cfg.url)
    );
    const cache: Module = module((b) => b.provide(Cache, () => 'x'));

    expectTypeOf(database).toEqualTypeOf<Module<{ url: string }>>();
    expectTypeOf(cache).toEqualTypeOf<Module>();
  });

  test('tokens resolve to their declared types after module composition', async () => {
    const database = module((b, cfg: { url: string }) => b.provide(Url, () => cfg.url));
    const app = await container()
      .use(database({ url: 'x' }))
      .start();

    expectTypeOf(app.get(Url)).toEqualTypeOf<string>();
    await app.stop();
  });
});
