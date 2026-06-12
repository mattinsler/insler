import { describe, expect, test } from 'bun:test';

import type { Serde } from '@insler/serde';
import { type AvroSchema, createAvroSerde } from '@insler/serde-avro';
import { expectTypeOf } from 'expect-type';

// The schema-required adapter from the consumer side (subsystem-branding
// issue 0008): unlike the schemaless formats, @insler/serde-avro exports a
// factory — a consumer supplies an Avro schema and gets back a standard
// Serde<Uint8Array>, interchangeable with every other binary adapter at the
// same seam. Avro schemas are this package's local concern (they are NOT the
// rpc contract's zod schemas — see the serde boundaries).

const orderSchema: AvroSchema = {
  type: 'record',
  name: 'Order',
  fields: [
    { name: 'id', type: 'string' },
    { name: 'quantity', type: 'int' },
    { name: 'price', type: 'double' },
    {
      name: 'item',
      type: {
        type: 'record',
        name: 'Item',
        fields: [
          { name: 'sku', type: 'string' },
          { name: 'inStock', type: 'boolean' },
        ],
      },
    },
  ],
};

describe('createAvroSerde as a consumer uses it', () => {
  test('a schema-bound serde round-trips a nested record', () => {
    const serde = createAvroSerde(orderSchema);
    const order = {
      id: 'ord-1',
      quantity: 3,
      price: 19.5,
      item: { sku: 'SKU-9', inStock: true },
    };
    expect(serde.decode(serde.encode(order))).toEqual(order);
  });

  test('primitive schemas work the same way', () => {
    expect(createAvroSerde('string').decode(createAvroSerde('string').encode('hello'))).toBe(
      'hello'
    );
    expect(createAvroSerde('int').decode(createAvroSerde('int').encode(42))).toBe(42);
  });

  test('two serdes from the same schema are wire-compatible (producer/consumer split)', () => {
    // The deployment shape: the encoding side and the decoding side each
    // construct their own serde from the shared schema.
    const producer = createAvroSerde(orderSchema);
    const consumer = createAvroSerde(orderSchema);
    const order = { id: 'ord-2', quantity: 1, price: 5, item: { sku: 'SKU-1', inStock: false } };
    expect(consumer.decode(producer.encode(order))).toEqual(order);
  });

  test('the factory returns a standard Serde<Uint8Array>, swappable with the other binary adapters', () => {
    const serde = createAvroSerde(orderSchema);
    expectTypeOf(serde).toEqualTypeOf<Serde<Uint8Array>>();
    expect(
      serde.encode({ id: 'x', quantity: 0, price: 0, item: { sku: 's', inStock: true } })
    ).toBeInstanceOf(Uint8Array);
  });

  test('type surface: the schema parameter is required — a bare call must not compile', () => {
    // Compile-only: the violating call lives in a never-invoked closure (it
    // would also throw at runtime, but the guarantee under test is the type).
    function _rejectsSchemaless(): void {
      // @ts-expect-error Avro is schema-required; there is no schemaless default
      createAvroSerde();
    }
    expect(typeof _rejectsSchemaless).toBe('function');
  });
});
