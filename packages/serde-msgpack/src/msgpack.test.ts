import { test, expect, describe } from 'bun:test';

import { msgpackSerde } from './msgpack.js';

describe('msgpackSerde', () => {
  test('roundtrips a string', () => {
    const value = 'hello world';
    expect(msgpackSerde.decode(msgpackSerde.encode(value))).toBe(value);
  });

  test('roundtrips a number', () => {
    expect(msgpackSerde.decode(msgpackSerde.encode(42))).toBe(42);
    expect(msgpackSerde.decode(msgpackSerde.encode(3.14))).toBe(3.14);
  });

  test('roundtrips a boolean', () => {
    expect(msgpackSerde.decode(msgpackSerde.encode(true))).toBe(true);
    expect(msgpackSerde.decode(msgpackSerde.encode(false))).toBe(false);
  });

  test('roundtrips null', () => {
    expect(msgpackSerde.decode(msgpackSerde.encode(null))).toBeNull();
  });

  test('roundtrips undefined as empty Uint8Array', () => {
    const encoded = msgpackSerde.encode(undefined);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBe(0);
    expect(msgpackSerde.decode(encoded)).toBeUndefined();
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
    expect(msgpackSerde.decode(msgpackSerde.encode(value))).toEqual(value);
  });

  test('roundtrips arrays with mixed types', () => {
    const value = [1, 'two', true, null, { nested: 'value' }];
    expect(msgpackSerde.decode(msgpackSerde.encode(value))).toEqual(value);
  });

  test('roundtrips empty objects and arrays', () => {
    expect(msgpackSerde.decode(msgpackSerde.encode({}))).toEqual({});
    expect(msgpackSerde.decode(msgpackSerde.encode([]))).toEqual([]);
  });

  test('encode returns a Uint8Array', () => {
    const encoded = msgpackSerde.encode({ a: 1 });
    expect(encoded).toBeInstanceOf(Uint8Array);
  });

  test('roundtrips binary data', () => {
    const value = { data: new Uint8Array([1, 2, 3, 4, 5]) };
    const result = msgpackSerde.decode(msgpackSerde.encode(value)) as { data: Uint8Array };
    expect(new Uint8Array(result.data)).toEqual(value.data);
  });

  test('produces smaller output than JSON for objects', () => {
    const value = {
      users: [
        { name: 'Alice', age: 30, active: true },
        { name: 'Bob', age: 25, active: false },
      ],
      meta: { page: 1, total: 100 },
    };
    const msgpackSize = msgpackSerde.encode(value).length;
    const jsonSize = new TextEncoder().encode(JSON.stringify(value)).length;
    expect(msgpackSize).toBeLessThan(jsonSize);
  });
});
