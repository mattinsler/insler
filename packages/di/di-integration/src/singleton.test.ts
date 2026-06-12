import { describe, expect, test } from 'bun:test';

import { container, factoryToken, managed, parameterizedToken, singleton, token } from '@insler/di';

// Cross-container resource sharing through the public surface
// (subsystem-branding issue 0007): singleton() wraps a factory so multiple
// containers share one reference-counted instance, cleaned up only when the
// last container stops — the consumer-facing lifecycle story, against built
// dist output.

describe('singleton()', () => {
  test('two containers share one instance; cleanup fires when the last stops', async () => {
    let created = 0;
    let closed = 0;
    const Pool = token<{ id: number }>('pool');
    const createSharedPool = singleton(async () => {
      created += 1;
      const pool = { id: created };
      return managed(pool, async () => {
        closed += 1;
      });
    });

    const app1 = await container()
      .provide(Pool, () => createSharedPool())
      .start();
    const app2 = await container()
      .provide(Pool, () => createSharedPool())
      .start();

    expect(created).toBe(1);
    expect(app1.get(Pool)).toBe(app2.get(Pool));

    await app1.stop(); // decrements the refcount — the pool stays alive
    expect(closed).toBe(0);
    await app2.stop(); // refcount hits 0 — cleanup fires
    expect(closed).toBe(1);
  });

  test('after all references release, the next use creates a fresh instance', async () => {
    let created = 0;
    const Pool = token<number>('pool');
    const shared = singleton(async () => {
      created += 1;
      return managed(created, async () => {});
    });

    const first = await container()
      .provide(Pool, () => shared())
      .start();
    await first.stop();

    const second = await container()
      .provide(Pool, () => shared())
      .start();

    expect(created).toBe(2);
    expect(second.get(Pool)).toBe(2);
    await second.stop();
  });

  test('factory + singleton + managed: parameterized shared resources', async () => {
    // The most common production pattern from the di guide: a factory
    // creates parameterized instances, each backed by a managed singleton.
    const stops: string[] = [];
    const Db = factoryToken<string, string>('db');
    const users = parameterizedToken<string, string>('db', 'users', 'users');
    const Consumer = token<string>('consumer');

    const sharedDb = singleton(async (schema: string) => {
      return managed(`db:${schema}`, async () => {
        stops.push(schema);
      });
    });

    const app = await container()
      .factory(Db, (schema) => () => sharedDb(schema))
      .provide(Consumer, [users], (db) => `uses ${db}`)
      .start();

    expect(app.get(Consumer)).toBe('uses db:users');
    await app.stop();
    expect(stops).toEqual(['users']);
  });
});
