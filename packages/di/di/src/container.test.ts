import { test, expect, describe } from 'bun:test';

import { container, ContainerBuilder, withDeps } from './container.js';
import { managed } from './managed.js';
import { ContainerManifest } from './manifest.js';
import { token, factoryToken, parameterizedToken, lazyToken } from './token.js';

describe('container()', () => {
  test('returns a ContainerBuilder', () => {
    expect(container()).toBeInstanceOf(ContainerBuilder);
  });
});

describe('ContainerBuilder.provide()', () => {
  test('resolves a simple binding with no deps', async () => {
    const Greeting = token<string>('greeting');
    const c = await container()
      .provide(Greeting, () => 'hello')
      .start();
    expect(c.get(Greeting)).toBe('hello');
    await c.stop();
  });

  test('resolves binding with array deps', async () => {
    const A = token<number>('a');
    const B = token<number>('b');
    const Sum = token<number>('sum');

    const c = await container()
      .provide(A, () => 3)
      .provide(B, () => 4)
      .provide(Sum, [A, B], (a, b) => a + b)
      .start();

    expect(c.get(Sum)).toBe(7);
    await c.stop();
  });

  test('resolves binding with record deps', async () => {
    const Host = token<string>('host');
    const Port = token<number>('port');
    const Url = token<string>('url');

    const c = await container()
      .provide(Host, () => 'localhost')
      .provide(Port, () => 8080)
      .provide(Url, { host: Host, port: Port }, ({ host, port }) => `${host}:${port}`)
      .start();

    expect(c.get(Url)).toBe('localhost:8080');
    await c.stop();
  });

  test('skips duplicate provide for the same token name', async () => {
    const A = token<string>('a');

    const c = await container()
      .provide(A, () => 'first')
      .provide(A, () => 'second')
      .start();

    expect(c.get(A)).toBe('first');
    await c.stop();
  });

  test('resolves async factories', async () => {
    const A = token<string>('a');
    const c = await container()
      .provide(A, async () => 'async-value')
      .start();
    expect(c.get(A)).toBe('async-value');
    await c.stop();
  });
});

describe('ContainerBuilder.factory()', () => {
  test('expands factory tokens via metaFactory returning a function', async () => {
    const DbToken = factoryToken<string, { host: string }>('db');
    const primary = parameterizedToken<string, { host: string }>('db', 'primary', {
      host: 'primary.db',
    });
    const replica = parameterizedToken<string, { host: string }>('db', 'replica', {
      host: 'replica.db',
    });
    const App = token<string>('app');

    const c = await container()
      .factory(DbToken, (config) => () => `connection:${config.host}`)
      .provide(App, [primary, replica], (p, r) => `${p}|${r}`)
      .start();

    expect(c.get(App)).toBe('connection:primary.db|connection:replica.db');
    await c.stop();
  });

  test('expands factory tokens via metaFactory returning { deps, factory }', async () => {
    const Config = token<number>('config');
    const ServiceToken = factoryToken<string, string>('service');
    const svcA = parameterizedToken<string, string>('service', 'a', 'alpha');
    const App = token<string>('app');

    const c = await container()
      .factory(ServiceToken, (config) => ({
        deps: [Config],
        factory: (cfg: number) => `${config}:${cfg}`,
      }))
      .provide(Config, () => 42)
      .provide(App, [svcA], (a) => `app(${a})`)
      .start();

    expect(c.get(App)).toBe('app(alpha:42)');
    await c.stop();
  });

  test('factory with deps on the factory registration itself', async () => {
    const Multiplier = token<number>('multiplier');
    const FToken = factoryToken<number, number>('computed');
    const computed5 = parameterizedToken<number, number>('computed', 'five', 5);
    const Result = token<number>('result');

    const c = await container()
      .provide(Multiplier, () => 10)
      .factory(FToken, [Multiplier], (config) => (mult: number) => config * mult)
      .provide(Result, [computed5], (v) => v)
      .start();

    expect(c.get(Result)).toBe(50);
    await c.stop();
  });

  test('skips duplicate factory registration', async () => {
    const FToken = factoryToken<string, string>('f');
    const inst = parameterizedToken<string, string>('f', 'x', 'first');
    const App = token<string>('app');

    const c = await container()
      .factory(FToken, (config) => () => `a:${config}`)
      .factory(FToken, (config) => () => `b:${config}`)
      .provide(App, [inst], (v) => v)
      .start();

    expect(c.get(App)).toBe('a:first');
    await c.stop();
  });
});

describe('ContainerBuilder.lazy()', () => {
  test('registers a lazy factory for on-demand resolution', async () => {
    const LazyFToken = token<string>('lazy-svc');
    const lazyInst = lazyToken<string>('lazy-svc', 'x');
    const Eager = token<string>('eager');

    const c = await container()
      .lazy(LazyFToken, () => 'lazy-value')
      .provide(Eager, () => 'eager-val')
      .start();

    expect(c.get(Eager)).toBe('eager-val');
    const resolved = await c.resolve(lazyInst);
    expect(resolved).toBe('lazy-value');
    await c.stop();
  });

  test('skips duplicate lazy registration when factory already registered', async () => {
    const FToken = factoryToken<string, string>('dup');
    const LazyFToken = token<string>('dup');
    const inst = parameterizedToken<string, string>('dup', 'k', 'cfg');
    const App = token<string>('app');

    const c = await container()
      .factory(FToken, (config) => () => `factory:${config}`)
      .lazy(LazyFToken, () => 'lazy-value')
      .provide(App, [inst], (v) => v)
      .start();

    expect(c.get(App)).toBe('factory:cfg');
    await c.stop();
  });

  test('lazy with array deps', async () => {
    const Base = token<number>('base');
    const LazyFToken = token<number>('lazy-dep');
    const lazyInst = lazyToken<number>('lazy-dep', 'a');

    const c = await container()
      .provide(Base, () => 10)
      .lazy(LazyFToken, [Base], (base) => base * 5)
      .start();

    const val = await c.resolve(lazyInst);
    expect(val).toBe(50);
    await c.stop();
  });

  test('lazy with record deps', async () => {
    const Base = token<number>('base');
    const LazyFToken = token<number>('lazy-rec');
    const lazyInst = lazyToken<number>('lazy-rec', 'a');

    const c = await container()
      .provide(Base, () => 7)
      .lazy(LazyFToken, { base: Base }, ({ base }) => base * 3)
      .start();

    const val = await c.resolve(lazyInst);
    expect(val).toBe(21);
    await c.stop();
  });
});

describe('Managed bindings', () => {
  test('unwraps managed values and calls stop in reverse order', async () => {
    const order: string[] = [];
    const A = token<string>('a');
    const B = token<string>('b');

    const c = await container()
      .provide(A, () =>
        managed('a-val', async () => {
          order.push('stop-a');
        })
      )
      .provide(B, [A], (a) =>
        managed(`b(${a})`, async () => {
          order.push('stop-b');
        })
      )
      .start();

    expect(c.get(A)).toBe('a-val');
    expect(c.get(B)).toBe('b(a-val)');

    await c.stop();
    expect(order).toEqual(['stop-b', 'stop-a']);
  });

  test('managed values from lazy resolution get stop callbacks', async () => {
    let stopped = false;
    const LazyFToken = token<string>('lazy-managed');
    const lazyInst = lazyToken<string>('lazy-managed', 'x');

    const c = await container()
      .lazy(LazyFToken, () =>
        managed('m:val', async () => {
          stopped = true;
        })
      )
      .start();

    const val = await c.resolve(lazyInst);
    expect(val).toBe('m:val');
    expect(stopped).toBe(false);

    await c.stop();
    expect(stopped).toBe(true);
  });
});

describe('ContainerBuilder.use()', () => {
  test('applies a function to the builder and returns the builder', async () => {
    const A = token<string>('a');

    function addA(b: ContainerBuilder) {
      return b.provide(A, () => 'from-use');
    }

    const c = await container().use(addA).start();
    expect(c.get(A)).toBe('from-use');
    await c.stop();
  });
});

describe('ContainerBuilder.init()', () => {
  test('runs initializers after all bindings are resolved', async () => {
    const A = token<string>('a');
    let initValue: string | undefined;

    const c = await container()
      .provide(A, () => 'value')
      .init((resolved) => {
        initValue = resolved.get(A);
      })
      .start();

    expect(initValue).toBe('value');
    await c.stop();
  });

  test('stops container if initializer throws', async () => {
    const A = token<string>('a');
    let stopped = false;

    const builder = container()
      .provide(A, () =>
        managed('val', async () => {
          stopped = true;
        })
      )
      .init(() => {
        throw new Error('init failed');
      });

    await expect(builder.start()).rejects.toThrow('init failed');
    expect(stopped).toBe(true);
  });

  test('swallows stop error when initializer throws', async () => {
    const A = token<string>('a');

    const builder = container()
      .provide(A, () =>
        managed('val', async () => {
          throw new Error('stop also failed');
        })
      )
      .init(() => {
        throw new Error('init failed');
      });

    await expect(builder.start()).rejects.toThrow('init failed');
  });
});

describe('ContainerBuilder.defer()', () => {
  test('runs deferred registrations before expanding factories', async () => {
    const A = token<string>('a');

    const c = await container()
      .defer(async (builder) => {
        builder.provide(A, () => 'deferred-value');
      })
      .start();

    expect(c.get(A)).toBe('deferred-value');
    await c.stop();
  });
});

describe('ContainerBuilder.link()', () => {
  test('adds ordering deps based on link rules', async () => {
    const order: string[] = [];
    const A = token<string>('a');
    const B = token<string>('b');

    const c = await container()
      .provide(A, () => {
        order.push('a');
        return 'a';
      })
      .provide(B, () => {
        order.push('b');
        return 'b';
      })
      .link((ctx) => {
        if (ctx.name === 'b') return ['a'];
      })
      .start();

    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    await c.stop();
  });

  test('link rule only adds deps that exist in bindings', async () => {
    const A = token<string>('a');

    const c = await container()
      .provide(A, () => 'a')
      .link((ctx) => {
        if (ctx.name === 'a') return ['nonexistent'];
      })
      .start();

    expect(c.get(A)).toBe('a');
    await c.stop();
  });

  test('link rule can use hasBinding to check for existing bindings', async () => {
    const order: string[] = [];
    const A = token<string>('a');
    const B = token<string>('b');
    const C = token<string>('c');

    const c = await container()
      .provide(A, () => {
        order.push('a');
        return 'a';
      })
      .provide(B, () => {
        order.push('b');
        return 'b';
      })
      .provide(C, () => {
        order.push('c');
        return 'c';
      })
      .link((ctx) => {
        if (ctx.name === 'c' && ctx.hasBinding('a')) return ['a', 'b'];
      })
      .start();

    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
    await c.stop();
  });

  test('link rule context includes existing deps', async () => {
    const A = token<string>('a');
    const B = token<string>('b');
    const C = token<string>('c');
    let capturedDeps: string[] = [];

    const c = await container()
      .provide(A, () => 'a')
      .provide(B, [A], (a) => `b(${a})`)
      .provide(C, () => 'c')
      .link((ctx) => {
        if (ctx.name === 'b') capturedDeps = ctx.deps;
      })
      .start();

    expect(capturedDeps).toEqual(['a']);
    await c.stop();
  });
});

describe('withDeps()', () => {
  test('creates a deps+factory pair with array deps', () => {
    const A = token<number>('a');
    const result = withDeps([A], (a: number) => a * 2);
    expect(result.deps).toEqual([A]);
    expect(typeof result.factory).toBe('function');
  });

  test('creates a deps+factory pair with record deps', () => {
    const A = token<number>('a');
    const result = withDeps({ a: A }, ({ a }: { a: number }) => a * 2);
    expect(result.deps).toEqual({ a: A });
    expect(typeof result.factory).toBe('function');
  });
});

describe('Error handling', () => {
  test('throws on missing dependency', async () => {
    const A = token<string>('a');
    const B = token<string>('b');

    const builder = container().provide(A, [B], (b) => b);
    await expect(builder.start()).rejects.toThrow('Token "a" depends on "b" which is not provided');
  });

  test('throws on circular dependency', async () => {
    const A = token<string>('a');
    const B = token<string>('b');

    const builder = container()
      .provide(A, [B], (b) => b)
      .provide(B, [A], (a) => a);

    await expect(builder.start()).rejects.toThrow(/Circular dependency/);
  });

  test('ResolvedContainer.get throws for unprovided token', async () => {
    const A = token<string>('a');
    const Missing = token<string>('missing');

    const c = await container()
      .provide(A, () => 'a')
      .start();
    expect(() => c.get(Missing)).toThrow('Token "missing" was not provided');
    await c.stop();
  });

  test('ResolvedContainer.resolve throws for token without factory', async () => {
    const lazyInst = lazyToken<string>('no-factory', 'x');
    const A = token<string>('a');

    const c = await container()
      .provide(A, () => 'a')
      .start();
    await expect(c.resolve(lazyInst)).rejects.toThrow(
      'Token "no-factory:x" was not provided and no factory "no-factory" is registered'
    );
    await c.stop();
  });

  test('factory resolution failure stops already-resolved bindings', async () => {
    let stopped = false;
    const A = token<string>('a');
    const B = token<string>('b');

    const builder = container()
      .provide(A, () =>
        managed('a-val', async () => {
          stopped = true;
        })
      )
      .provide(B, [A], () => {
        throw new Error('factory error');
      });

    await expect(builder.start()).rejects.toThrow('factory error');
    expect(stopped).toBe(true);
  });

  test('resolution failure swallows stop errors during cleanup', async () => {
    const A = token<string>('a');
    const B = token<string>('b');

    const builder = container()
      .provide(A, () =>
        managed('a-val', async () => {
          throw new Error('stop failed too');
        })
      )
      .provide(B, [A], () => {
        throw new Error('factory error');
      });

    await expect(builder.start()).rejects.toThrow('factory error');
  });

  test('stop collects multiple errors into AggregateError', async () => {
    const A = token<string>('a');
    const B = token<string>('b');

    const c = await container()
      .provide(A, () =>
        managed('a', async () => {
          throw new Error('stop-a-error');
        })
      )
      .provide(B, () =>
        managed('b', async () => {
          throw new Error('stop-b-error');
        })
      )
      .start();

    try {
      await c.stop();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      expect((err as AggregateError).message).toContain('Container shutdown errors');
    }
  });
});

describe('Parallel resolution levels', () => {
  test('bindings at the same level resolve in parallel', async () => {
    const A = token<string>('a');
    const B = token<string>('b');
    const C = token<string>('c');

    const timestamps: Record<string, number> = {};
    const c = await container()
      .provide(A, async () => {
        timestamps.a = Date.now();
        await new Promise((r) => setTimeout(r, 50));
        return 'a';
      })
      .provide(B, async () => {
        timestamps.b = Date.now();
        await new Promise((r) => setTimeout(r, 50));
        return 'b';
      })
      .provide(C, [A, B], (a, b) => {
        timestamps.c = Date.now();
        return `${a}+${b}`;
      })
      .start();

    expect(c.get(C)).toBe('a+b');
    expect(Math.abs(timestamps.a! - timestamps.b!)).toBeLessThan(40);
    expect(timestamps.c!).toBeGreaterThanOrEqual(timestamps.a!);
    await c.stop();
  });
});

describe('ResolvedContainer.resolveAll()', () => {
  test('resolves a single token', async () => {
    const A = token<string>('a');
    const c = await container()
      .provide(A, () => 'val')
      .start();
    const val = await c.resolveAll(A);
    expect(val).toBe('val');
    await c.stop();
  });

  test('resolves an array of tokens', async () => {
    const A = token<number>('a');
    const B = token<number>('b');
    const c = await container()
      .provide(A, () => 1)
      .provide(B, () => 2)
      .start();

    const [a, b] = await c.resolveAll([A, B]);
    expect(a).toBe(1);
    expect(b).toBe(2);
    await c.stop();
  });

  test('resolves a record of tokens', async () => {
    const A = token<number>('a');
    const B = token<string>('b');
    const c = await container()
      .provide(A, () => 10)
      .provide(B, () => 'hello')
      .start();

    const result = await c.resolveAll({ num: A, str: B });
    expect(result).toEqual({ num: 10, str: 'hello' });
    await c.stop();
  });

  test('resolveAll with lazy tokens triggers lazy expansion', async () => {
    const LazyFToken = factoryToken<string, string>('lazy-all');
    const lazyA = lazyToken<string, string>('lazy-all', 'a', 'alpha');
    const lazyB = lazyToken<string, string>('lazy-all', 'b', 'beta');

    const c = await container()
      .factory(LazyFToken, (config) => () => `resolved:${config}`)
      .start();

    const [a, b] = await c.resolveAll([lazyA, lazyB]);
    expect(a).toBe('resolved:alpha');
    expect(b).toBe('resolved:beta');
    await c.stop();
  });
});

describe('Lazy resolution deduplication', () => {
  test('concurrent resolve calls for the same lazy token share one resolution', async () => {
    let count = 0;
    const LazyFToken = factoryToken<string, string>('dedup');
    const lazyInst = lazyToken<string, string>('dedup', 'k', 'cfg');

    const c = await container()
      .factory(LazyFToken, (config) => async () => {
        count++;
        await new Promise((r) => setTimeout(r, 20));
        return `val:${config}`;
      })
      .start();

    const [a, b] = await Promise.all([c.resolve(lazyInst), c.resolve(lazyInst)]);
    expect(a).toBe('val:cfg');
    expect(b).toBe('val:cfg');
    expect(count).toBe(1);
    await c.stop();
  });
});

describe('Lazy expansion via factoryToken with { deps, factory }', () => {
  test('lazy token resolved via factory with array deps', async () => {
    const Base = token<number>('base');
    const LazyFToken = factoryToken<number, number>('lazy-inner');
    const lazyInst = lazyToken<number, number>('lazy-inner', 'x', 3);

    const c = await container()
      .provide(Base, () => 10)
      .factory(LazyFToken, (config) => ({
        deps: [Base],
        factory: (base: number) => config * base,
      }))
      .start();

    const val = await c.resolve(lazyInst);
    expect(val).toBe(30);
    await c.stop();
  });

  test('lazy token resolved via factory with record deps', async () => {
    const Base = token<number>('base');
    const LazyFToken = factoryToken<number, number>('lazy-inner-rec');
    const lazyInst = lazyToken<number, number>('lazy-inner-rec', 'x', 4);

    const c = await container()
      .provide(Base, () => 5)
      .factory(LazyFToken, (config) => ({
        deps: { base: Base },
        factory: ({ base }: { base: number }) => config * base,
      }))
      .start();

    const val = await c.resolve(lazyInst);
    expect(val).toBe(20);
    await c.stop();
  });
});

describe('ContainerManifest', () => {
  test('manifest() returns a ContainerManifest', () => {
    const A = token<string>('a');
    const B = token<string>('b');

    const manifest = container()
      .provide(A, () => 'a')
      .provide(B, [A], (a) => a)
      .manifest();

    expect(manifest).toBeInstanceOf(ContainerManifest);
    expect(manifest.bindings.length).toBe(2);
  });

  test('manifest reports unresolved dependencies', () => {
    const A = token<string>('a');
    const B = token<string>('b');

    const manifest = container()
      .provide(A, [B], (b) => b)
      .manifest();

    expect(manifest.unresolved).toContain('b');
  });

  test('manifest levels reflect dependency structure', () => {
    const A = token<string>('a');
    const B = token<string>('b');
    const C = token<string>('c');

    const manifest = container()
      .provide(A, () => 'a')
      .provide(B, () => 'b')
      .provide(C, [A, B], (a, b) => `${a}${b}`)
      .manifest();

    expect(manifest.levels.length).toBe(2);
    const level0Names = manifest.levels[0]!.map((b) => b.name);
    expect(level0Names).toContain('a');
    expect(level0Names).toContain('b');
    expect(manifest.levels[1]!.map((b) => b.name)).toContain('c');
  });

  test('manifest includes factory info', () => {
    const FToken = factoryToken<string, string>('my-factory');
    const inst = parameterizedToken<string, string>('my-factory', 'x', 'cfg');
    const App = token<string>('app');

    const manifest = container()
      .factory(FToken, (config) => () => config)
      .provide(App, [inst], (v) => v)
      .manifest();

    expect(manifest.factories.some((f) => f.baseName === 'my-factory')).toBe(true);
  });

  test('manifest includes factory deps', () => {
    const Dep = token<number>('dep');
    const FToken = factoryToken<string, string>('with-deps');
    const inst = parameterizedToken<string, string>('with-deps', 'x', 'cfg');
    const App = token<string>('app');

    const manifest = container()
      .provide(Dep, () => 1)
      .factory(FToken, [Dep], (config) => (d: number) => `${config}:${d}`)
      .provide(App, [inst], (v) => v)
      .manifest();

    const factoryEntry = manifest.factories.find((f) => f.baseName === 'with-deps');
    expect(factoryEntry).toBeDefined();
    expect(factoryEntry!.deps).toContain('dep');
  });

  test('manifest counts initializers and deferred', () => {
    const A = token<string>('a');

    const manifest = container()
      .provide(A, () => 'a')
      .init(() => {})
      .init(() => {})
      .defer(async () => {})
      .manifest();

    expect(manifest.initializerCount).toBe(2);
    expect(manifest.deferredCount).toBe(1);
  });

  test('tree() renders a dependency tree', () => {
    const A = token<string>('a');
    const B = token<string>('b');
    const C = token<string>('c');

    const manifest = container()
      .provide(A, () => 'a')
      .provide(B, [A], (a) => a)
      .provide(C, [A, B], (a, b) => `${a}${b}`)
      .manifest();

    const tree = manifest.tree('c');
    expect(tree).toContain('c');
    expect(tree).toContain('a');
    expect(tree).toContain('b');
  });

  test('tree() handles circular references gracefully', () => {
    const A = token<string>('a');
    const B = token<string>('b');

    const builder = container()
      .provide(A, [B], (b) => b)
      .provide(B, [A], (a) => a);

    const manifest = builder.manifest();
    const tree = manifest.tree('a');
    expect(tree).toContain('(circular)');
  });

  test('toString() produces a readable manifest', () => {
    const A = token<string>('a');
    const B = token<string>('b');

    const manifest = container()
      .provide(A, () => 'a')
      .provide(B, [A], (a) => a)
      .manifest();

    const str = manifest.toString();
    expect(str).toContain('Container Dependency Manifest');
    expect(str).toContain('Level 0');
    expect(str).toContain('Level 1');
  });

  test('toString() includes factory, unresolved, initializer, and deferred info', () => {
    const FToken = factoryToken<string, string>('fac');
    const Missing = token<string>('missing');
    const A = token<string>('a');

    const manifest = container()
      .factory(FToken, (c) => () => c)
      .provide(A, [Missing], (m) => m)
      .init(() => {})
      .defer(async () => {})
      .manifest();

    const str = manifest.toString();
    expect(str).toContain('Factories:');
    expect(str).toContain('fac');
    expect(str).toContain('Unresolved:');
    expect(str).toContain('missing');
    expect(str).toContain('Initializers:');
    expect(str).toContain('Deferred:');
  });

  test('manifest expands factories for deps of bindings', () => {
    const FToken = factoryToken<string, string>('svc');
    const inst = parameterizedToken<string, string>('svc', 'a', 'alpha');
    const App = token<string>('app');

    const manifest = container()
      .factory(FToken, (config) => () => config)
      .provide(App, [inst], (v) => v)
      .manifest();

    expect(manifest.bindings.some((b) => b.name === inst.name)).toBe(true);
    expect(manifest.unresolved.length).toBe(0);
  });

  test('manifest skips factory expansion when metaFactory throws', () => {
    const FToken = factoryToken<string, string>('failing');
    const inst = parameterizedToken<string, string>('failing', 'x', 'cfg');
    const App = token<string>('app');

    const manifest = container()
      .factory(FToken, () => {
        throw new Error('bad factory');
      })
      .provide(App, [inst], (v) => v)
      .manifest();

    expect(manifest.unresolved).toContain(inst.name);
  });
});

describe('Complex scenarios', () => {
  test('deep dependency chain resolves in correct order', async () => {
    const order: string[] = [];
    const A = token<string>('a');
    const B = token<string>('b');
    const C = token<string>('c');
    const D = token<string>('d');

    const c = await container()
      .provide(A, () => {
        order.push('a');
        return 'a';
      })
      .provide(B, [A], (a) => {
        order.push('b');
        return `b(${a})`;
      })
      .provide(C, [B], (b) => {
        order.push('c');
        return `c(${b})`;
      })
      .provide(D, [C], (c_) => {
        order.push('d');
        return `d(${c_})`;
      })
      .start();

    expect(c.get(D)).toBe('d(c(b(a)))');
    expect(order).toEqual(['a', 'b', 'c', 'd']);
    await c.stop();
  });

  test('diamond dependency pattern', async () => {
    const A = token<string>('a');
    const B = token<string>('b');
    const C = token<string>('c');
    const D = token<string>('d');

    const c = await container()
      .provide(A, () => 'root')
      .provide(B, [A], (a) => `b(${a})`)
      .provide(C, [A], (a) => `c(${a})`)
      .provide(D, [B, C], (b, c_) => `d(${b},${c_})`)
      .start();

    expect(c.get(D)).toBe('d(b(root),c(root))');
    await c.stop();
  });

  test('use() composes multiple modules', async () => {
    const DbUrl = token<string>('dbUrl');
    const Cache = token<string>('cache');
    const App = token<string>('app');

    function dbModule(b: ContainerBuilder) {
      return b.provide(DbUrl, () => 'postgres://localhost');
    }

    function cacheModule(b: ContainerBuilder) {
      return b.provide(Cache, () => 'redis://localhost');
    }

    const c = await container()
      .use(dbModule)
      .use(cacheModule)
      .provide(App, { db: DbUrl, cache: Cache }, ({ db, cache }) => `app(${db},${cache})`)
      .start();

    expect(c.get(App)).toBe('app(postgres://localhost,redis://localhost)');
    await c.stop();
  });
});
