import { describe, expect, test } from 'bun:test';

import { container, factoryToken, lazyToken, parameterizedToken, token } from '@insler/di';

// Token families through the public surface (subsystem-branding issue 0007):
// one factory serves parameterized instances (params hashed into the name,
// shared baseName), lazy tokens defer materialization until resolved after
// start, and resolveAll fans out across dependency shapes — all consumed
// exactly as an external consumer would, against built dist output.

describe('factory tokens and parameterized instances', () => {
  test('one factory serves every parameterized token of its family', async () => {
    const Conn = factoryToken<string, { host: string }>('db');
    const primary = parameterizedToken<string, { host: string }>('db', 'primary', {
      host: 'primary.db',
    });
    const replica = parameterizedToken<string, { host: string }>('db', 'replica', {
      host: 'replica.db',
    });
    const App = token<string[]>('app');

    const app = await container()
      .factory(Conn, (config) => () => `conn:${config.host}`)
      .provide(App, [primary, replica], (p, r) => [p, r])
      .start();

    expect(app.get(App)).toEqual(['conn:primary.db', 'conn:replica.db']);
    // The family shares one baseName; each instance is its own binding.
    expect(primary.baseName).toBe(replica.baseName);
    expect(primary.name).not.toBe(replica.name);
    await app.stop();
  });

  test('factories declare their own dependencies', async () => {
    const Logger = token<string[]>('logger');
    const Svc = factoryToken<string, string>('svc');
    const a = parameterizedToken<string, string>('svc', 'a', 'alpha');

    const app = await container()
      .provide(Logger, () => [])
      .factory(Svc, [Logger], (config) => (logger) => {
        logger.push(`created ${config}`);
        return `svc:${config}`;
      })
      .provide(token<string>('user'), [a], (svc) => svc)
      .start();

    expect(app.get(Logger)).toEqual(['created alpha']);
    await app.stop();
  });
});

describe('lazy resolution', () => {
  test('lazy tokens materialize on demand after start, not during it', async () => {
    let created = 0;
    const Cache = factoryToken<string, { region: string }>('cache');
    const usEast = lazyToken<string, { region: string }>('cache', 'us-east', {
      region: 'us-east',
    });

    const app = await container()
      .factory(Cache, (config) => () => {
        created += 1;
        return `cache:${config.region}`;
      })
      .start();

    expect(created).toBe(0);
    expect(await app.resolve(usEast)).toBe('cache:us-east');
    expect(created).toBe(1);
    await app.stop();
  });

  test('resolveAll resolves single tokens, tuples, and records', async () => {
    const A = token<number>('a');
    const B = token<string>('b');

    const app = await container()
      .provide(A, () => 7)
      .provide(B, () => 'x')
      .start();

    expect(await app.resolveAll(A)).toBe(7);
    expect(await app.resolveAll([A, B])).toEqual([7, 'x']);
    expect(await app.resolveAll({ a: A, b: B })).toEqual({ a: 7, b: 'x' });
    await app.stop();
  });

  test('a lazy token must not type-check in the synchronous get()', async () => {
    const Lazy = factoryToken<string, string>('lazy-only');
    const instance = lazyToken<string, string>('lazy-only', 'x', 'x');

    const app = await container()
      .factory(Lazy, () => () => 'value')
      .start();

    // @ts-expect-error lazy tokens resolve asynchronously — get() accepts eager tokens only
    void (() => app.get(instance));
    expect(await app.resolve(instance)).toBe('value');
    await app.stop();
  });
});
