import { test, expect, describe } from 'bun:test';

import { createAvroSerde } from './avro.js';

describe('createAvroSerde', () => {
  test('roundtrips a string with a primitive schema', () => {
    const serde = createAvroSerde('string');
    expect(serde.decode(serde.encode('hello world'))).toBe('hello world');
  });

  test('roundtrips a number with int schema', () => {
    const serde = createAvroSerde('int');
    expect(serde.decode(serde.encode(42))).toBe(42);
  });

  test('roundtrips a number with double schema', () => {
    const serde = createAvroSerde('double');
    expect(serde.decode(serde.encode(3.14))).toBe(3.14);
  });

  test('roundtrips a boolean', () => {
    const serde = createAvroSerde('boolean');
    expect(serde.decode(serde.encode(true))).toBe(true);
    expect(serde.decode(serde.encode(false))).toBe(false);
  });

  test('roundtrips null', () => {
    const serde = createAvroSerde('null');
    expect(serde.decode(serde.encode(null))).toBeNull();
  });

  test('roundtrips a record', () => {
    const serde = createAvroSerde({
      type: 'record',
      name: 'User',
      fields: [
        { name: 'name', type: 'string' },
        { name: 'age', type: 'int' },
        { name: 'active', type: 'boolean' },
      ],
    });
    const value = { name: 'Alice', age: 30, active: true };
    expect(serde.decode(serde.encode(value))).toEqual(value);
  });

  test('roundtrips a nested record', () => {
    const serde = createAvroSerde({
      type: 'record',
      name: 'Order',
      fields: [
        { name: 'id', type: 'string' },
        {
          name: 'item',
          type: {
            type: 'record',
            name: 'Item',
            fields: [
              { name: 'name', type: 'string' },
              { name: 'price', type: 'double' },
            ],
          },
        },
        { name: 'quantity', type: 'int' },
      ],
    });
    const value = {
      id: 'order-1',
      item: { name: 'Widget', price: 9.99 },
      quantity: 3,
    };
    expect(serde.decode(serde.encode(value))).toEqual(value);
  });

  test('roundtrips an array', () => {
    const serde = createAvroSerde({ type: 'array', items: 'string' });
    const value = ['a', 'b', 'c'];
    expect(serde.decode(serde.encode(value))).toEqual(value);
  });

  test('roundtrips a map', () => {
    const serde = createAvroSerde({ type: 'map', values: 'int' });
    const value = { x: 10, y: 20, z: 30 };
    expect(serde.decode(serde.encode(value))).toEqual(value);
  });

  test('roundtrips a union (nullable field)', () => {
    const serde = createAvroSerde({
      type: 'record',
      name: 'Profile',
      fields: [
        { name: 'name', type: 'string' },
        { name: 'bio', type: ['null', 'string'], default: null },
      ],
    });
    const withBio = { name: 'Alice', bio: 'Developer' };
    expect(serde.decode(serde.encode(withBio))).toEqual(withBio);

    const withoutBio = { name: 'Bob', bio: null };
    expect(serde.decode(serde.encode(withoutBio))).toEqual(withoutBio);
  });

  test('roundtrips an enum', () => {
    const serde = createAvroSerde({
      type: 'enum',
      name: 'Color',
      symbols: ['RED', 'GREEN', 'BLUE'],
    });
    expect(serde.decode(serde.encode('RED'))).toBe('RED');
    expect(serde.decode(serde.encode('BLUE'))).toBe('BLUE');
  });

  test('encode returns a Uint8Array', () => {
    const serde = createAvroSerde('string');
    const encoded = serde.encode('test');
    expect(encoded).toBeInstanceOf(Uint8Array);
  });

  test('produces compact binary output', () => {
    const serde = createAvroSerde({
      type: 'record',
      name: 'User',
      fields: [
        { name: 'name', type: 'string' },
        { name: 'age', type: 'int' },
      ],
    });
    const value = { name: 'Alice', age: 30 };
    const avroSize = serde.encode(value).length;
    const jsonSize = new TextEncoder().encode(JSON.stringify(value)).length;
    expect(avroSize).toBeLessThan(jsonSize);
  });
});
