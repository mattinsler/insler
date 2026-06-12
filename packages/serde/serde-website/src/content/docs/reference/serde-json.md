---
title: '@insler/serde-json'
description: SuperJSON-backed JSON serdes — jsonSerde (strings) and jsonBytesSerde (UTF-8 bytes), with Date, Map, Set, BigInt, and RegExp surviving the round-trip.
sidebar:
  order: 2
---

The JSON adapter package, built on
[SuperJSON](https://github.com/flightcontrolhq/superjson): rich types plain
JSON cannot carry — `Date`, `Map`, `Set`, `BigInt`, `RegExp` — survive the
round-trip. It ships two implementations of the core interface, one per wire
type.

```sh
bun add @insler/serde-json
```

## `jsonSerde` — `Serde<string>`

Encodes values to SuperJSON strings:

```ts
import { jsonSerde } from '@insler/serde-json';

const wire = jsonSerde.encode({ createdAt: new Date(), tags: new Set(['a', 'b']) });
// SuperJSON string

const value = jsonSerde.decode(wire);
// { createdAt: Date, tags: Set(['a', 'b']) }
```

Encoding `undefined` produces an empty string, and decoding an empty string
returns `undefined` — the convention every serde implementation honors.

## `jsonBytesSerde` — `Serde<Uint8Array>`

The string serde over UTF-8, for binary transports:

```ts
import { jsonBytesSerde } from '@insler/serde-json';

const bytes = jsonBytesSerde.encode({ count: 42 });
// Uint8Array

const value = jsonBytesSerde.decode(bytes);
// { count: 42 }
```

`jsonBytesSerde` is the default lineage of the
[rpc subsystem](https://rpc.insler.dev)'s NATS transport — reach for this
package when a transport or propagator needs an explicit JSON serde
dependency rather than the inline default.

## Boundaries

Depends on `@insler/serde` (the interface) and `superjson` — nothing else.
It owns JSON behavior only; the binary-compact formats are the
[MessagePack](/reference/serde-msgpack/), [CBOR](/reference/serde-cbor/),
and [Avro](/reference/serde-avro/) adapters.
