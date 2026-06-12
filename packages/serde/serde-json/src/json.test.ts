import { test, expect, describe } from 'bun:test';

import type { Serde } from '@insler/serde';

import { jsonBytesSerde, jsonSerde } from './json.js';

describe('jsonSerde', () => {
  test('roundtrips a string', () => {
    const value = 'hello world';
    expect(jsonSerde.decode(jsonSerde.encode(value))).toBe(value);
  });

  test('roundtrips a number', () => {
    expect(jsonSerde.decode(jsonSerde.encode(42))).toBe(42);
    expect(jsonSerde.decode(jsonSerde.encode(3.14))).toBe(3.14);
    expect(jsonSerde.decode(jsonSerde.encode(-0))).toBe(-0);
  });

  test('roundtrips a boolean', () => {
    expect(jsonSerde.decode(jsonSerde.encode(true))).toBe(true);
    expect(jsonSerde.decode(jsonSerde.encode(false))).toBe(false);
  });

  test('roundtrips null', () => {
    expect(jsonSerde.decode(jsonSerde.encode(null))).toBeNull();
  });

  test('roundtrips undefined as empty string', () => {
    const encoded = jsonSerde.encode(undefined);
    expect(encoded).toBe('');
    expect(jsonSerde.decode(encoded)).toBeUndefined();
  });

  test('roundtrips a complex nested object', () => {
    const value = {
      name: 'test',
      count: 42,
      nested: {
        flag: true,
        items: [1, 'two', null],
      },
    };
    expect(jsonSerde.decode(jsonSerde.encode(value))).toEqual(value);
  });

  test('roundtrips a Date', () => {
    const value = new Date('2024-01-15T12:30:00.000Z');
    const result = jsonSerde.decode(jsonSerde.encode(value));
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).toISOString()).toBe(value.toISOString());
  });

  test('roundtrips a Map', () => {
    const value = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    const result = jsonSerde.decode(jsonSerde.encode(value));
    expect(result).toBeInstanceOf(Map);
    expect(result).toEqual(value);
  });

  test('roundtrips a Set', () => {
    const value = new Set([1, 2, 3, 'four']);
    const result = jsonSerde.decode(jsonSerde.encode(value));
    expect(result).toBeInstanceOf(Set);
    expect(result).toEqual(value);
  });

  test('roundtrips BigInt', () => {
    const value = BigInt('9007199254740993');
    const result = jsonSerde.decode(jsonSerde.encode(value));
    expect(result).toBe(value);
  });

  test('roundtrips arrays with mixed types', () => {
    const value = [1, 'two', true, null, { nested: 'value' }];
    expect(jsonSerde.decode(jsonSerde.encode(value))).toEqual(value);
  });

  test('roundtrips empty objects and arrays', () => {
    expect(jsonSerde.decode(jsonSerde.encode({}))).toEqual({});
    expect(jsonSerde.decode(jsonSerde.encode([]))).toEqual([]);
  });

  test('encode returns a string', () => {
    expect(typeof jsonSerde.encode({ a: 1 })).toBe('string');
  });
});

describe('jsonBytesSerde', () => {
  test('roundtrips a string', () => {
    const value = 'hello world';
    expect(jsonBytesSerde.decode(jsonBytesSerde.encode(value))).toBe(value);
  });

  test('roundtrips a number', () => {
    expect(jsonBytesSerde.decode(jsonBytesSerde.encode(42))).toBe(42);
  });

  test('roundtrips a boolean', () => {
    expect(jsonBytesSerde.decode(jsonBytesSerde.encode(true))).toBe(true);
  });

  test('roundtrips null', () => {
    expect(jsonBytesSerde.decode(jsonBytesSerde.encode(null))).toBeNull();
  });

  test('roundtrips undefined as empty Uint8Array', () => {
    const encoded = jsonBytesSerde.encode(undefined);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBe(0);
    expect(jsonBytesSerde.decode(encoded)).toBeUndefined();
  });

  test('encode returns a Uint8Array', () => {
    const encoded = jsonBytesSerde.encode({ a: 1 });
    expect(encoded).toBeInstanceOf(Uint8Array);
  });

  test('roundtrips a Date', () => {
    const value = new Date('2024-06-01T00:00:00.000Z');
    const result = jsonBytesSerde.decode(jsonBytesSerde.encode(value));
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).toISOString()).toBe(value.toISOString());
  });

  test('roundtrips a Map', () => {
    const value = new Map<string, number>([
      ['x', 10],
      ['y', 20],
    ]);
    const result = jsonBytesSerde.decode(jsonBytesSerde.encode(value));
    expect(result).toBeInstanceOf(Map);
    expect(result).toEqual(value);
  });

  test('roundtrips a Set', () => {
    const value = new Set(['a', 'b', 'c']);
    const result = jsonBytesSerde.decode(jsonBytesSerde.encode(value));
    expect(result).toBeInstanceOf(Set);
    expect(result).toEqual(value);
  });

  test('roundtrips BigInt', () => {
    const value = BigInt('12345678901234567890');
    const result = jsonBytesSerde.decode(jsonBytesSerde.encode(value));
    expect(result).toBe(value);
  });

  test('roundtrips complex nested object', () => {
    const value = {
      users: [
        { name: 'Alice', age: 30 },
        { name: 'Bob', age: 25 },
      ],
      meta: { page: 1, total: 100 },
    };
    expect(jsonBytesSerde.decode(jsonBytesSerde.encode(value))).toEqual(value);
  });

  test('produces same decoded values as jsonSerde', () => {
    const values = [
      42,
      'hello',
      true,
      null,
      { key: 'value' },
      [1, 2, 3],
      new Date('2024-01-01'),
      new Map([['a', 1]]),
      new Set([1, 2]),
    ];
    for (const value of values) {
      const fromJson = jsonSerde.decode(jsonSerde.encode(value));
      const fromBytes = jsonBytesSerde.decode(jsonBytesSerde.encode(value));
      expect(fromBytes).toEqual(fromJson);
    }
  });
});

describe('custom Serde implementation', () => {
  test('can implement a simple JSON serde without superjson', () => {
    const simpleSerde: Serde<string> = {
      encode(value: unknown): string {
        return JSON.stringify(value);
      },
      decode(wire: string): unknown {
        return JSON.parse(wire);
      },
    };

    const value = { name: 'test', count: 42, items: [1, 2, 3] };
    expect(simpleSerde.decode(simpleSerde.encode(value))).toEqual(value);
  });

  test('custom serde does not preserve Date instances (unlike jsonSerde)', () => {
    const simpleSerde: Serde<string> = {
      encode(value: unknown): string {
        return JSON.stringify(value);
      },
      decode(wire: string): unknown {
        return JSON.parse(wire);
      },
    };

    const date = new Date('2024-01-01');
    const result = simpleSerde.decode(simpleSerde.encode(date));
    expect(result).not.toBeInstanceOf(Date);
    expect(typeof result).toBe('string');

    const preserved = jsonSerde.decode(jsonSerde.encode(date));
    expect(preserved).toBeInstanceOf(Date);
  });
});
