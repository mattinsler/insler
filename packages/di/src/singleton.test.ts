import { test, expect, describe } from 'bun:test';

import { managed } from './managed.js';
import { singleton } from './singleton.js';

describe('singleton()', () => {
  test('returns the same value across multiple calls', async () => {
    let created = 0;
    const create = singleton(() => {
      created++;
      return 'instance';
    });

    const a = await create();
    const b = await create();
    expect(a.value).toBe('instance');
    expect(b.value).toBe('instance');
    expect(created).toBe(1);
  });

  test('passes args to factory on first call', async () => {
    const create = singleton((port: number) => `server:${port}`);
    const result = await create(3000);
    expect(result.value).toBe('server:3000');
  });

  test('reference counting - cleans up when last reference is stopped', async () => {
    let stopped = false;
    const create = singleton(() =>
      managed('resource', async () => {
        stopped = true;
      })
    );

    const a = await create();
    const b = await create();
    expect(stopped).toBe(false);

    await a.stop!();
    expect(stopped).toBe(false);

    await b.stop!();
    expect(stopped).toBe(true);
  });

  test('recreates after all references are stopped', async () => {
    let count = 0;
    const create = singleton(() => {
      count++;
      return `instance-${count}`;
    });

    const first = await create();
    expect(first.value).toBe('instance-1');
    await first.stop!();

    const second = await create();
    expect(second.value).toBe('instance-2');
  });

  test('handles async factories', async () => {
    const create = singleton(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 'async-value';
    });

    const result = await create();
    expect(result.value).toBe('async-value');
  });

  test('handles managed return from async factory', async () => {
    let stopped = false;
    const create = singleton(async () => {
      return managed('val', async () => {
        stopped = true;
      });
    });

    const result = await create();
    expect(result.value).toBe('val');
    await result.stop!();
    expect(stopped).toBe(true);
  });

  test('concurrent callers share the same initialization', async () => {
    let count = 0;
    const create = singleton(async () => {
      await new Promise((r) => setTimeout(r, 10));
      count++;
      return `value-${count}`;
    });

    const [a, b, c] = await Promise.all([create(), create(), create()]);
    expect(a.value).toBe('value-1');
    expect(b.value).toBe('value-1');
    expect(c.value).toBe('value-1');
    expect(count).toBe(1);
  });

  test('stop callback is not present when factory returns plain value without managed', async () => {
    const create = singleton(() => 'plain');
    const result = await create();
    expect(result.value).toBe('plain');
    expect(result.stop).toBeDefined();
    await result.stop!();
  });
});
