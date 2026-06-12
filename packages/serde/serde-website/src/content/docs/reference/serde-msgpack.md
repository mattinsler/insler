---
title: '@insler/serde-msgpack'
description: MessagePack serde — msgpackSerde, a compact binary Serde<Uint8Array> backed by @msgpack/msgpack.
sidebar:
  order: 3
---

The MessagePack adapter package: `msgpackSerde`, a `Serde<Uint8Array>`
backed by [`@msgpack/msgpack`](https://github.com/msgpack/msgpack-javascript).
Reach for it when compact binary encoding matters on a binary wire.

```sh
bun add @insler/serde-msgpack
```

## `msgpackSerde` — `Serde<Uint8Array>`

```ts
import { msgpackSerde } from '@insler/serde-msgpack';

const bytes = msgpackSerde.encode({ id: 'ord-1', quantity: 3, price: 19.5 });
// Uint8Array — MessagePack-encoded

const order = msgpackSerde.decode(bytes);
// { id: 'ord-1', quantity: 3, price: 19.5 }
```

It honors the shared serde conventions: `encode(undefined)` produces empty
bytes, decoding empty bytes returns `undefined`.

## Interchangeable behind the interface

`msgpackSerde` is a standard `Serde<Uint8Array>` — swap it with
[`jsonBytesSerde`](/reference/serde-json/), [`cborSerde`](/reference/serde-cbor/),
or an [Avro serde](/reference/serde-avro/) wherever a binary serde is
accepted, such as the [rpc subsystem](https://rpc.insler.dev)'s NATS
transport `serde` option. Develop on JSON, deploy on MessagePack, without
touching a call site.

## Boundaries

Depends on `@insler/serde` (the interface) and `@msgpack/msgpack` — it stays
transport-agnostic, a pure `Serde<Uint8Array>` with no transport-specific
assumptions.
