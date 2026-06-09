# @insler/serde-msgpack

MessagePack `Serde<Uint8Array>` implementation for `@insler` RPC, backed by [@msgpack/msgpack](https://github.com/msgpack/msgpack-javascript). A compact binary encoding for binary transports like NATS or WebSocket.

## Install

```sh
bun add @insler/serde-msgpack
```

## Usage

`msgpackSerde` encodes values to `Uint8Array` and decodes them back.

```ts
import { msgpackSerde } from '@insler/serde-msgpack';

const bytes = msgpackSerde.encode({ count: 42, tags: ['a', 'b'] });
// Uint8Array

const value = msgpackSerde.decode(bytes);
// { count: 42, tags: ['a', 'b'] }
```

Encoding `undefined` produces an empty `Uint8Array`, and decoding an empty `Uint8Array` returns `undefined`.

## License

MIT
