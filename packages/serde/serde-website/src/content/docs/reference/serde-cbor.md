---
title: '@insler/serde-cbor'
description: CBOR serde — cborSerde, a compact self-describing binary Serde<Uint8Array> backed by cbor2.
sidebar:
  order: 4
---

The CBOR adapter package: `cborSerde`, a `Serde<Uint8Array>` backed by
[`cbor2`](https://github.com/hildjj/cbor2). Reach for it when CBOR's
compact, self-describing binary encoding (RFC 8949) is wanted on a binary
wire.

```sh
bun add @insler/serde-cbor
```

## `cborSerde` — `Serde<Uint8Array>`

```ts
import { cborSerde } from '@insler/serde-cbor';

const bytes = cborSerde.encode({ id: 'ord-1', quantity: 3, price: 19.5 });
// Uint8Array — CBOR-encoded

const order = cborSerde.decode(bytes);
// { id: 'ord-1', quantity: 3, price: 19.5 }
```

It honors the shared serde conventions: `encode(undefined)` produces empty
bytes, decoding empty bytes returns `undefined`.

## Interchangeable behind the interface

`cborSerde` is a standard `Serde<Uint8Array>` — swap it with
[`jsonBytesSerde`](/reference/serde-json/),
[`msgpackSerde`](/reference/serde-msgpack/), or an
[Avro serde](/reference/serde-avro/) wherever a binary serde is accepted,
such as the [rpc subsystem](https://rpc.insler.dev)'s NATS transport `serde`
option.

## Boundaries

Depends on `@insler/serde` (the interface) and `cbor2` — it is
transport-agnostic by design, coupled to nothing but the `Serde<Uint8Array>`
seam.
