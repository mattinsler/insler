---
title: '@insler/serde-avro'
description: Avro serde — createAvroSerde(schema), a schema-driven compact binary Serde<Uint8Array> backed by avsc.
sidebar:
  order: 5
---

The Avro adapter package, backed by
[`avsc`](https://github.com/mtth/avsc). Unlike the schemaless formats, Avro
is **schema-required**, so this package exports a factory rather than a
ready-made instance: supply an Avro schema and get back a standard
`Serde<Uint8Array>`.

```sh
bun add @insler/serde-avro
```

## `createAvroSerde(schema)` — `Serde<Uint8Array>`

```ts
import { createAvroSerde, type AvroSchema } from '@insler/serde-avro';

const orderSchema: AvroSchema = {
  type: 'record',
  name: 'Order',
  fields: [
    { name: 'id', type: 'string' },
    { name: 'quantity', type: 'int' },
    { name: 'price', type: 'double' },
  ],
};

const serde = createAvroSerde(orderSchema);
const bytes = serde.encode({ id: 'ord-1', quantity: 3, price: 19.5 });
const order = serde.decode(bytes);
```

The schema parameter is required — there is no schemaless default. Primitive
schemas (`'string'`, `'int'`, …) work the same way as record schemas.

## Producer/consumer wire compatibility

Both sides of a wire construct their own serde from the shared schema; two
serdes from the same schema are wire-compatible. The returned serde is a
standard `Serde<Uint8Array>`, swappable with
[`jsonBytesSerde`](/reference/serde-json/),
[`msgpackSerde`](/reference/serde-msgpack/), and
[`cborSerde`](/reference/serde-cbor/) wherever a binary serde is accepted —
pass it to a binary transport's `serde` option when a schema-driven compact
format is needed.

## Boundaries

Depends on `@insler/serde` (the interface) and `avsc`. Avro schemas are this
package's **local concern** — they are not the
[rpc subsystem](https://rpc.insler.dev) contract's zod schemas; the two are
separate by design.

Exports: `createAvroSerde` and the `AvroSchema` type.
