# serde — Pluggable wire serialization for TypeScript

One tiny interface — **`Serde<Wire>`**: `encode` a value to a wire format, `decode` it back —
and format adapters that implement it: JSON (SuperJSON-backed, rich types survive),
MessagePack, CBOR, and Avro. Anything that moves values over a wire takes a `Serde` — the
`@insler/rpc` transports take one as their `serde` option — so swapping the format is a
one-argument change, never a call-site rewrite. The zero-dependency core owns the interface;
each format binding is its own adapter package.

**Full documentation: [serde.insler.dev](https://serde.insler.dev)**

## Install

One adapter install yields a working serde — the JSON adapter ships both a string serde and a
bytes serde for binary transports, and brings the interface package with it:

```sh
bun add @insler/serde-json
```

Implementing your own format instead? The interface lives in the zero-dependency core:

```sh
bun add @insler/serde
```

## A minimal round-trip

```ts
import { jsonSerde } from '@insler/serde-json';

const wire = jsonSerde.encode({ createdAt: new Date(), tags: new Set(['a', 'b']) });
const value = jsonSerde.decode(wire);
// { createdAt: Date, tags: Set(['a', 'b']) } — rich types survive (SuperJSON)
```

Every adapter implements the same two-method interface from the core, with `Wire` as the only
knob — `encode(undefined)` produces an empty wire and decoding an empty wire returns
`undefined`, in every implementation:

```ts
import type { Serde } from '@insler/serde';

const plain: Serde<string> = {
  encode: (value) => (value === undefined ? '' : JSON.stringify(value)),
  decode: (wire) => (wire === '' ? undefined : JSON.parse(wire)),
};
```

The binary adapters are all `Serde<Uint8Array>`, so they are interchangeable wherever a binary
transport asks for one.

## What's in this directory

### The umbrella package — `@insler/serde` ([`serde/`](./serde/README.md))

serde is a single-entrypoint core: the root import is the whole public surface — and it is the
bottom of the stack, with **zero dependencies**.

| Entrypoint      | Purpose                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| `@insler/serde` | The `Serde<Wire>` interface (`encode(value): Wire` / `decode(wire): unknown`) — the contract every format adapter implements and every transport accepts |

### Adapter packages

Each format binding is its own package, depending only on the core and its format library:

| Package                                                                | Purpose                                                                                          |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `@insler/serde-json` ([`serde-json/`](./serde-json/README.md))          | SuperJSON-backed JSON: `jsonSerde` (`Serde<string>`) and `jsonBytesSerde` (`Serde<Uint8Array>`) — Date, Map, Set, BigInt, and RegExp survive the round-trip |
| `@insler/serde-msgpack` ([`serde-msgpack/`](./serde-msgpack/README.md)) | MessagePack `msgpackSerde` (`Serde<Uint8Array>`) — compact binary encoding via `@msgpack/msgpack` |
| `@insler/serde-cbor` ([`serde-cbor/`](./serde-cbor/README.md))          | CBOR `cborSerde` (`Serde<Uint8Array>`) — compact, self-describing binary encoding via `cbor2`     |
| `@insler/serde-avro` ([`serde-avro/`](./serde-avro/README.md))          | Avro `createAvroSerde(schema)` (`Serde<Uint8Array>`) — schema-driven compact encoding via `avsc`  |

## Where to go next

- [serde.insler.dev](https://serde.insler.dev) — getting started and the full docs for the
  interface and every format adapter.
- Each package's own README (linked above) for its complete API surface.
- Putting a serde on the wire? The [rpc subsystem](https://rpc.insler.dev)
  (`@insler/rpc-transport-nats`) takes any `Serde<Uint8Array>` as its `serde` option — develop
  on JSON, deploy on MessagePack or CBOR, without touching a call site.
