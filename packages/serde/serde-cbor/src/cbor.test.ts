import { test, expect, describe } from 'bun:test';

import { cborSerde } from './cbor.js';

describe('cborSerde', () => {
  test('roundtrips a string', () => {
    const value = 'hello world';
    expect(cborSerde.decode(cborSerde.encode(value))).toBe(value);
  });

  test('roundtrips a number', () => {
    expect(cborSerde.decode(cborSerde.encode(42))).toBe(42);
    expect(cborSerde.decode(cborSerde.encode(3.14))).toBe(3.14);
  });

  test('roundtrips a boolean', () => {
    expect(cborSerde.decode(cborSerde.encode(true))).toBe(true);
    expect(cborSerde.decode(cborSerde.encode(false))).toBe(false);
  });

  test('roundtrips null', () => {
    expect(cborSerde.decode(cborSerde.encode(null))).toBeNull();
  });

  test('roundtrips undefined as empty Uint8Array', () => {
    const encoded = cborSerde.encode(undefined);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBe(0);
    expect(cborSerde.decode(encoded)).toBeUndefined();
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
    expect(cborSerde.decode(cborSerde.encode(value))).toEqual(value);
  });

  test('roundtrips arrays with mixed types', () => {
    const value = [1, 'two', true, null, { nested: 'value' }];
    expect(cborSerde.decode(cborSerde.encode(value))).toEqual(value);
  });

  test('roundtrips empty objects and arrays', () => {
    expect(cborSerde.decode(cborSerde.encode({}))).toEqual({});
    expect(cborSerde.decode(cborSerde.encode([]))).toEqual([]);
  });

  test('encode returns a Uint8Array', () => {
    const encoded = cborSerde.encode({ a: 1 });
    expect(encoded).toBeInstanceOf(Uint8Array);
  });

  test('roundtrips a Date natively', () => {
    const value = new Date('2024-01-15T12:30:00.000Z');
    const result = cborSerde.decode(cborSerde.encode(value));
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).toISOString()).toBe(value.toISOString());
  });

  test('roundtrips BigInt natively', () => {
    const value = BigInt('9007199254740993');
    const result = cborSerde.decode(cborSerde.encode(value));
    expect(result).toBe(value);
  });

  test('roundtrips binary data', () => {
    const value = new Uint8Array([1, 2, 3, 4, 5]);
    const result = cborSerde.decode(cborSerde.encode(value));
    expect(new Uint8Array(result as Uint8Array)).toEqual(value);
  });

  test('roundtrips Map with non-string keys natively', () => {
    const value = new Map<number, string>([
      [1, 'a'],
      [2, 'b'],
    ]);
    const result = cborSerde.decode(cborSerde.encode(value));
    expect(result).toBeInstanceOf(Map);
    expect(result).toEqual(value);
  });
});
