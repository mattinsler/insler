import { test, expect, describe } from 'bun:test';

import { Managed, managed, isManaged } from './managed.js';

describe('Managed', () => {
  test('stores value', () => {
    const m = new Managed('hello');
    expect(m.value).toBe('hello');
    expect(m.stop).toBeUndefined();
  });

  test('stores value and stop callback', () => {
    const stop = async () => {};
    const m = new Managed(42, stop);
    expect(m.value).toBe(42);
    expect(m.stop).toBe(stop);
  });
});

describe('managed()', () => {
  test('creates a Managed instance without stop', () => {
    const m = managed('value');
    expect(m).toBeInstanceOf(Managed);
    expect(m.value).toBe('value');
    expect(m.stop).toBeUndefined();
  });

  test('creates a Managed instance with stop', () => {
    const stop = async () => {};
    const m = managed('value', stop);
    expect(m.value).toBe('value');
    expect(m.stop).toBe(stop);
  });
});

describe('isManaged()', () => {
  test('returns true for Managed instances', () => {
    expect(isManaged(new Managed('x'))).toBe(true);
    expect(isManaged(managed('x'))).toBe(true);
  });

  test('returns false for non-Managed values', () => {
    expect(isManaged('string')).toBe(false);
    expect(isManaged(42)).toBe(false);
    expect(isManaged(null)).toBe(false);
    expect(isManaged(undefined)).toBe(false);
    expect(isManaged({ value: 'x' })).toBe(false);
    expect(isManaged({ value: 'x', stop: async () => {} })).toBe(false);
  });
});
