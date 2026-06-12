import { describe, expect, test } from 'bun:test';

import { container, managed, token } from '@insler/di';
import { expectTypeOf } from 'expect-type';

// The di subsystem's tracer-bullet integration test (subsystem-branding
// issue 0007): tokens -> provide -> start -> get -> stop end-to-end,
// consuming the subsystem exactly as an external consumer would — the public
// `@insler/di` entrypoint, resolved to built dist output (run `bun run
// build` first). di is a standalone in-process container, so unlike the rpc
// template no infrastructure is provisioned: the suite IS the consumer.

describe('container: provide and resolve', () => {
  test('typed tokens resolve through record and positional dependency shapes', async () => {
    const Greeting = token<string>('greeting');
    const Audience = token<string>('audience');
    const Message = token<string>('message');
    const Shout = token<string>('shout');

    const app = await container()
      .provide(Greeting, () => 'Hello')
      .provide(Audience, () => 'world')
      .provide(
        Message,
        { greeting: Greeting, audience: Audience },
        ({ greeting, audience }) => `${greeting}, ${audience}!`
      )
      .provide(Shout, [Message], (message) => message.toUpperCase())
      .start();

    expect(app.get(Message)).toBe('Hello, world!');
    expect(app.get(Shout)).toBe('HELLO, WORLD!');
    expectTypeOf(app.get(Message)).toEqualTypeOf<string>();
    await app.stop();
  });

  test('independent async bindings resolve in parallel', async () => {
    // a's factory blocks on a gate only b's factory releases — the container
    // deadlocks here unless independent bindings start concurrently.
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const A = token<string>('a');
    const B = token<string>('b');

    const app = await container()
      .provide(A, async () => {
        await gateA;
        return 'a';
      })
      .provide(B, async () => {
        releaseA();
        return 'b';
      })
      .start();

    expect(app.get(A)).toBe('a');
    expect(app.get(B)).toBe('b');
    await app.stop();
  });

  test('token config drives binding logic (typed keys, not just names)', async () => {
    function collection(name: string) {
      return token<string, string>(`collection:${name}`, name);
    }
    const Users = collection('users');
    const Posts = collection('posts');

    const app = await container()
      .provide(Users, () => `table:${Users.config}`)
      .provide(Posts, () => `table:${Posts.config}`)
      .start();

    expect(app.get(Users)).toBe('table:users');
    expect(app.get(Posts)).toBe('table:posts');
    await app.stop();
  });
});

describe('managed lifecycle', () => {
  test('stop() runs managed cleanups in reverse dependency order', async () => {
    const stops: string[] = [];
    const Conn = token<string>('conn');
    const Repo = token<string>('repo');
    const App = token<string>('app');

    const app = await container()
      .provide(Conn, () =>
        managed('conn', async () => {
          stops.push('conn');
        })
      )
      .provide(Repo, [Conn], (conn) =>
        managed(`repo(${conn})`, async () => {
          stops.push('repo');
        })
      )
      .provide(App, [Repo], (repo) =>
        managed(`app(${repo})`, async () => {
          stops.push('app');
        })
      )
      .start();

    expect(app.get(App)).toBe('app(repo(conn))');
    await app.stop();
    // Dependents shut down before their dependencies.
    expect(stops).toEqual(['app', 'repo', 'conn']);
  });

  test('managed values unwrap to the value itself for dependents and get()', async () => {
    const Db = token<{ url: string }>('db');
    const Url = token<string>('url');

    const app = await container()
      .provide(Db, () => managed({ url: 'postgres://localhost' }, async () => {}))
      .provide(Url, [Db], (db) => db.url)
      .start();

    expect(app.get(Db)).toEqual({ url: 'postgres://localhost' });
    expect(app.get(Url)).toBe('postgres://localhost');
    await app.stop();
  });
});

describe('type surface (consumer-side guarantees)', () => {
  test('a plain token with no factory must not type-check in provide()', async () => {
    const Orphan = token<string>('orphan');
    const Filled = token<string>('filled');
    const builder = container().provide(Filled, () => 'ok');
    // @ts-expect-error provide(plainToken) with no factory is reserved for BoundToken (inject) — the brand must hold
    void (() => builder.provide(Orphan));
    const app = await builder.start();
    expect(app.get(Filled)).toBe('ok');
    await app.stop();
  });

  test('dependency value types flow into factories', async () => {
    const Port = token<number>('port');
    const Host = token<string>('host');
    const Url = token<string>('url');

    const app = await container()
      .provide(Port, () => 8080)
      .provide(Host, () => 'localhost')
      .provide(Url, { host: Host, port: Port }, (deps) => {
        expectTypeOf(deps.host).toEqualTypeOf<string>();
        expectTypeOf(deps.port).toEqualTypeOf<number>();
        return `${deps.host}:${deps.port}`;
      })
      .start();

    expect(app.get(Url)).toBe('localhost:8080');
    await app.stop();
  });
});
