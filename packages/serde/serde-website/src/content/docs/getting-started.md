---
title: Getting started
description: From `bun add @insler/serde-json` to round-tripping values through every format adapter — and implementing your own.
---

This guide takes you from one install to a working round-trip, swaps the
format behind the same seam, and finishes by implementing the interface
yourself.

## 1. Install an adapter

The umbrella package is the *interface*; a working encoder/decoder is one
adapter install away. Start with JSON — it brings the interface package with
it:

```sh
bun add @insler/serde-json
```

## 2. Round-trip a value

A serde is two methods: `encode` a value to a wire format, `decode` it back.
`jsonSerde` is SuperJSON-backed, so rich types plain JSON cannot carry —
`Date`, `Map`, `Set`, `BigInt`, `RegExp` — survive:

```ts
import { jsonSerde } from '@insler/serde-json';

const wire = jsonSerde.encode({ createdAt: new Date(), tags: new Set(['a', 'b']) });
// SuperJSON string

const value = jsonSerde.decode(wire);
// { createdAt: Date, tags: Set(['a', 'b']) }
```

Every implementation honors the same edge contract: `encode(undefined)`
produces an empty wire, and decoding an empty wire returns `undefined`.

## 3. Go binary

Binary transports want bytes, not strings. The JSON adapter ships
`jsonBytesSerde` (`Serde<Uint8Array>`), and the MessagePack and CBOR
adapters are drop-in replacements behind the same type:

```sh
bun add @insler/serde-msgpack @insler/serde-cbor
```

```ts
import type { Serde } from '@insler/serde';
import { jsonBytesSerde } from '@insler/serde-json';
import { msgpackSerde } from '@insler/serde-msgpack';
import { cborSerde } from '@insler/serde-cbor';

// All three are Serde<Uint8Array> — pick one, the call sites never change.
const serde: Serde<Uint8Array> = msgpackSerde;

const bytes = serde.encode({ id: 'ord-1', quantity: 3 });
const order = serde.decode(bytes);
```

This is the point of the interface: a transport (for example the
[rpc subsystem](https://rpc.insler.dev)'s NATS transport) takes any
`Serde<Uint8Array>` as its `serde` option, so swapping formats is a
one-argument change.

## 4. Schema-driven encoding with Avro

Unlike the schemaless formats, Avro is schema-required — the adapter exports
a factory. Supply an Avro schema and get back a standard `Serde<Uint8Array>`,
interchangeable with the other binary adapters:

```sh
bun add @insler/serde-avro
```

```ts
import { createAvroSerde, type AvroSchema } from '@insler/serde-avro';

const orderSchema: AvroSchema = {
  type: 'record',
  name: 'Order',
  fields: [
    { name: 'id', type: 'string' },
    { name: 'quantity', type: 'int' },
  ],
};

const avroSerde = createAvroSerde(orderSchema);
const bytes = avroSerde.encode({ id: 'ord-1', quantity: 3 });
const order = avroSerde.decode(bytes);
```

Both sides of a wire construct their serde from the shared schema — two
serdes from the same schema are wire-compatible. Avro schemas are this
adapter's local concern; they are not the rpc contract's zod schemas.

## 5. Implement your own format

The interface lives in the zero-dependency core. Implement its two methods
and your format plugs in everywhere a `Serde` is accepted — preserve the
`undefined` ↔ empty-wire round-trip:

```sh
bun add @insler/serde
```

```ts
import type { Serde } from '@insler/serde';

const plainJson: Serde<string> = {
  encode: (value) => (value === undefined ? '' : JSON.stringify(value)),
  decode: (wire) => (wire === '' ? undefined : JSON.parse(wire)),
};
```

`Wire` is the only knob — `encode` takes `unknown`, `decode` returns
`unknown`, and the type parameter is whatever your format puts on the wire.

## Where to go next

- **The interface.** [`@insler/serde`](/reference/serde/) — the `Serde<Wire>`
  contract every adapter implements.
- **The adapters.** [JSON](/reference/serde-json/),
  [MessagePack](/reference/serde-msgpack/), [CBOR](/reference/serde-cbor/),
  and [Avro](/reference/serde-avro/) — one page per package.
- **Put it on a wire.** The [rpc subsystem](https://rpc.insler.dev) takes any
  of these as a transport's `serde` option — and the rest of the
  [insler.dev](https://insler.dev) family composes the same way.
