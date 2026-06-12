# @insler/serde-avro

Avro `Serde<Uint8Array>` implementation for `@insler` RPC, backed by [avsc](https://github.com/mtth/avsc). Schema-driven binary encoding — the most compact wire format, at the cost of needing a schema per type.

## Install

```sh
bun add @insler/serde-avro
```

## Usage

Build a serde from an Avro schema with `createAvroSerde`. The returned serde encodes values to `Uint8Array` and decodes them back according to that schema.

```ts
import { createAvroSerde } from '@insler/serde-avro';

const userSerde = createAvroSerde({
  type: 'record',
  name: 'User',
  fields: [
    { name: 'id', type: 'string' },
    { name: 'age', type: 'int' },
  ],
});

const bytes = userSerde.encode({ id: 'u1', age: 42 });
// Uint8Array

const value = userSerde.decode(bytes);
// { id: 'u1', age: 42 }
```

Unlike the self-describing serdes (`@insler/serde-json`, `@insler/serde-cbor`, `@insler/serde-msgpack`), Avro carries no type information on the wire — encoder and decoder must agree on the schema.

## Types

`AvroSchema` is re-exported from `avsc` for annotating schema definitions.

```ts
import { createAvroSerde, type AvroSchema } from '@insler/serde-avro';

const schema: AvroSchema = { type: 'record', name: 'User', fields: [/* … */] };
const serde = createAvroSerde(schema);
```

## License

MIT
