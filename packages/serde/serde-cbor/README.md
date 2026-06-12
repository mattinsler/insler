# @insler/serde-cbor

CBOR `Serde<Uint8Array>` implementation for `@insler` RPC, backed by [cbor2](https://github.com/hildjj/cbor2). A compact binary alternative to JSON for binary transports like NATS or WebSocket.

## Install

```sh
bun add @insler/serde-cbor
```

## Usage

`cborSerde` encodes values to `Uint8Array` and decodes them back.

```ts
import { cborSerde } from '@insler/serde-cbor';

const bytes = cborSerde.encode({ count: 42, tags: ['a', 'b'] });
// Uint8Array

const value = cborSerde.decode(bytes);
// { count: 42, tags: ['a', 'b'] }
```

Encoding `undefined` produces an empty `Uint8Array`, and decoding an empty `Uint8Array` returns `undefined`.

## License

MIT
