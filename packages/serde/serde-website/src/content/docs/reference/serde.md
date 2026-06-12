---
title: '@insler/serde'
description: The zero-dependency core — the Serde<Wire> interface every format adapter implements and every transport accepts.
sidebar:
  order: 1
---

serde is a **single-entrypoint core**: the root `@insler/serde` import is the
whole public surface, and that surface is one interface. It has **zero
dependencies** — it is the bottom of the stack; nothing internal sits below
it.

```sh
bun add @insler/serde
```

## The `Serde<Wire>` interface

```ts
interface Serde<Wire = unknown> {
  encode(value: unknown): Wire;
  decode(wire: Wire): unknown;
}
```

- `encode(value)` — serialize any value to the wire type.
- `decode(wire)` — deserialize a wire value back; what you decode is what
  you encoded.
- `Wire` is the **only knob**: `string` for text wires, `Uint8Array` for
  binary transports, defaulting to `unknown`. No format-specific types ever
  leak into the interface.

## The conventions every implementation honors

- `encode(undefined)` produces an **empty wire** (empty string or empty
  bytes), and decoding an empty wire returns `undefined`. Preserve this
  round-trip in any implementation you write.
- A serde of one wire type is not assignable to another: a binary consumer
  asking for `Serde<Uint8Array>` rejects a `Serde<string>` at compile time,
  so formats can never be mixed accidentally.

## Implementing a format

Implement the two methods and your format plugs in everywhere a `Serde` is
accepted:

```ts
import type { Serde } from '@insler/serde';

const plainJson: Serde<string> = {
  encode: (value) => (value === undefined ? '' : JSON.stringify(value)),
  decode: (wire) => (wire === '' ? undefined : JSON.parse(wire)),
};
```

A new format belongs in its own `@insler/serde-<fmt>` adapter package
depending only on this core and its format library — the published adapters
([JSON](/reference/serde-json/), [MessagePack](/reference/serde-msgpack/),
[CBOR](/reference/serde-cbor/), [Avro](/reference/serde-avro/)) all follow
that shape.

## Where it sits

Anything that moves values over a wire takes a `Serde` — the
[rpc subsystem](https://rpc.insler.dev)'s transports accept one as their
`serde` option, with a JSON default. The core owns the contract; choosing
which serde a transport uses is the transport's business.
