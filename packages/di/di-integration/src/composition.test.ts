import { describe, expect, test } from 'bun:test';

import { container, inject, module, token, type ContainerBuilder, type Pack } from '@insler/di';

// Composition through the public surface (subsystem-branding issue 0007):
// packs via .use(), module() as the packaged pack + configure pattern,
// inject() as deps-bound partial application, plus defer/init/link and
// manifest introspection — the consumer-facing composition story of the
// agent library guide, against built dist output.

describe('packs and module()', () => {
  test('.use() composes hand-written packs', async () => {
    const DbUrl = token<string>('db-url');
    const Db = token<string>('db');
    const databasePack = (builder: ContainerBuilder) =>
      builder
        .provide(DbUrl, () => 'postgres://localhost')
        .provide(Db, [DbUrl], (url) => `db@${url}`);

    const app = await container().use(databasePack).start();

    expect(app.get(Db)).toBe('db@postgres://localhost');
    await app.stop();
  });

  test('module() packages a configurable definition unit (always called, never bare)', async () => {
    const Url = token<string>('url');
    const database = module((b, cfg: { url: string }) => b.provide(Url, () => cfg.url));

    const app = await container()
      .use(database({ url: 'postgres://db' }))
      .start();

    expect(app.get(Url)).toBe('postgres://db');
    await app.stop();
  });

  test('dev/prod swap rides on first-registration-wins', async () => {
    const Db = token<string>('db');
    const devInfra = module((b) => b.provide(Db, () => 'dev-db'));
    const defaults = module((b) => b.provide(Db, () => 'prod-db'));

    const dev = await container().use(devInfra()).use(defaults()).start();
    const prod = await container().use(defaults()).start();

    expect(dev.get(Db)).toBe('dev-db');
    expect(prod.get(Db)).toBe('prod-db');
    await dev.stop();
    await prod.stop();
  });

  test('plugins ride on config-carrying packs', async () => {
    const Server = token<string>('server');
    const Cors = token<string>('cors');
    const corsPlugin: Pack = (b) => b.provide(Cors, () => 'cors');
    const http = module((b, { plugins = [] }: { plugins?: Pack[] }) =>
      plugins.reduce(
        (acc, p) => acc.use(p),
        b.provide(Server, () => 'server')
      )
    );

    const app = await container()
      .use(http({ plugins: [corsPlugin] }))
      .start();

    expect(app.get(Server)).toBe('server');
    expect(app.get(Cors)).toBe('cors');
    await app.stop();
  });
});

describe('inject()', () => {
  test('binds deps to the first parameter and registers with a bare provide()', async () => {
    const Smtp = token<{ send(to: string, body: string): string }>('smtp');
    const sendEmail = inject({ smtp: Smtp }, ({ smtp }, to: string, body: string) =>
      smtp.send(to, body)
    );

    const app = await container()
      .provide(Smtp, () => ({ send: (to, body) => `${to}:${body}` }))
      .provide(sendEmail)
      .start();

    // Resolves eagerly — get() returns the callable synchronously, with the
    // remaining parameters still free.
    expect(app.get(sendEmail)('a@b.com', 'hi')).toBe('a@b.com:hi');
    await app.stop();
  });
});

describe('defer, init, and link', () => {
  test('defer() registers bindings asynchronously before start', async () => {
    const Plugin = token<string>('plugin');

    const app = await container()
      .defer(async (builder) => {
        await Promise.resolve();
        builder.provide(Plugin, () => 'discovered');
      })
      .start();

    expect(app.get(Plugin)).toBe('discovered');
    await app.stop();
  });

  test('init() runs against the resolved container after all bindings resolve', async () => {
    const Db = token<{ migrated: boolean }>('db');
    let observed: boolean | undefined;

    const app = await container()
      .provide(Db, () => ({ migrated: false }))
      .init((resolved) => {
        const db = resolved.get(Db);
        db.migrated = true;
        observed = db.migrated;
      })
      .start();

    expect(observed).toBe(true);
    expect(app.get(Db).migrated).toBe(true);
    await app.stop();
  });

  test('link() adds ordering-only deps via afterDeps (no value passed)', async () => {
    const order: string[] = [];
    const Seed = token<string>('seed:users');
    const Db = token<string>('db:users');

    const app = await container()
      .provide(Db, () => {
        order.push('db:users');
        return 'db';
      })
      .provide(Seed, () => {
        order.push('seed:users');
        return 'seeded';
      })
      .link(({ name, hasBinding }) => {
        if (name.startsWith('db:') && hasBinding(`seed:${name.slice('db:'.length)}`)) {
          return [`seed:${name.slice('db:'.length)}`];
        }
      })
      .start();

    expect(order.indexOf('seed:users')).toBeLessThan(order.indexOf('db:users'));
    await app.stop();
  });
});

describe('manifest introspection', () => {
  test('manifest() exposes the dependency graph before start', () => {
    const A = token<string>('a');
    const B = token<string>('b');
    const C = token<string>('c');

    const manifest = container()
      .provide(A, () => 'a')
      .provide(B, [A], (a) => a)
      .provide(C, [A, B], (a, b) => `${a}${b}`)
      .init(() => {})
      .defer(async () => {})
      .manifest();

    const byName = new Map(manifest.bindings.map((b) => [b.name, b]));
    expect(byName.get('c')?.deps.sort()).toEqual(['a', 'b']);
    expect(manifest.unresolved).toEqual([]);
    expect(manifest.initializerCount).toBe(1);
    expect(manifest.deferredCount).toBe(1);
    expect(manifest.tree('c')).toContain('a');
  });
});
