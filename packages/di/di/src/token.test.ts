import { test, expect, describe } from 'bun:test';

import { Token, token, factoryToken, parameterizedToken, lazyToken } from './token.js';

describe('Token', () => {
  test('stores name, baseName, and config', () => {
    const t = new Token('myToken', 'base', { port: 3000 });
    expect(t.name).toBe('myToken');
    expect(t.baseName).toBe('base');
    expect(t.config).toEqual({ port: 3000 });
  });

  test('is frozen after construction', () => {
    const t = new Token('t', 't', undefined);
    expect(() => {
      (t as any).name = 'changed';
    }).toThrow();
  });
});

describe('token()', () => {
  test('creates a token with matching name and baseName', () => {
    const t = token<string>('greeting');
    expect(t.name).toBe('greeting');
    expect(t.baseName).toBe('greeting');
    expect(t.config).toBeUndefined();
  });

  test('creates a token with config', () => {
    const t = token<number, { max: number }>('counter', { max: 10 });
    expect(t.name).toBe('counter');
    expect(t.config).toEqual({ max: 10 });
  });
});

describe('factoryToken()', () => {
  test('creates a token with undefined config', () => {
    const t = factoryToken<string>('factory');
    expect(t.name).toBe('factory');
    expect(t.baseName).toBe('factory');
    expect(t.config).toBeUndefined();
  });
});

describe('parameterizedToken()', () => {
  test('appends string parameter to name', () => {
    const t = parameterizedToken<string, string>('db', 'primary', 'primary');
    expect(t.name).toBe('db:primary');
    expect(t.baseName).toBe('db');
    expect(t.config).toBe('primary');
  });

  test('appends number parameter to name', () => {
    const t = parameterizedToken<string, number>('worker', 42, 42);
    expect(t.name).toBe('worker:42');
    expect(t.baseName).toBe('worker');
    expect(t.config).toBe(42);
  });

  test('hashes object parameter in name', () => {
    const t = parameterizedToken<string, { region: string }>(
      'cache',
      { region: 'us-east' },
      { region: 'us-east' }
    );
    expect(t.name).toMatch(/^cache:/);
    expect(t.name).not.toBe('cache:[object Object]');
    expect(t.baseName).toBe('cache');
    expect(t.config).toEqual({ region: 'us-east' });
  });

  test('accepts explicit config that overrides parameter as config', () => {
    const t = parameterizedToken<string, number>('svc', 'key', 99);
    expect(t.name).toBe('svc:key');
    expect(t.config).toBe(99);
  });

  test('same parameters produce the same hash', () => {
    const a = parameterizedToken<string>('x', { a: 1, b: 2 });
    const b = parameterizedToken<string>('x', { a: 1, b: 2 });
    expect(a.name).toBe(b.name);
  });
});

describe('lazyToken()', () => {
  test('appends string parameter to name', () => {
    const t = lazyToken<string, string>('lazy', 'key', 'key');
    expect(t.name).toBe('lazy:key');
    expect(t.baseName).toBe('lazy');
    expect(t.config).toBe('key');
  });

  test('appends number parameter to name', () => {
    const t = lazyToken<string, number>('lazy', 7, 7);
    expect(t.name).toBe('lazy:7');
    expect(t.baseName).toBe('lazy');
    expect(t.config).toBe(7);
  });

  test('hashes object parameter in name', () => {
    const t = lazyToken<string, { x: boolean }>('lazy', { x: true }, { x: true });
    expect(t.name).toMatch(/^lazy:/);
    expect(t.baseName).toBe('lazy');
    expect(t.config).toEqual({ x: true });
  });

  test('accepts explicit config', () => {
    const t = lazyToken<string, number>('lazy', 'key', 42);
    expect(t.name).toBe('lazy:key');
    expect(t.config).toBe(42);
  });
});
