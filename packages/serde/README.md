# @insler/serde

Serialization/deserialization interface and JSON implementations for the insler RPC transport layer with support for:

- Pluggable `Serde<Wire>` interface for custom serialization formats
- JSON string serialization via SuperJSON (preserves Date, Map, Set, etc.)
- JSON byte serialization for binary transports (NATS, WebSocket, etc.)

## Install

```sh
bun add @insler/serde
```

## Serde interface

The `Serde<Wire>` interface defines how values are encoded to and decoded from a wire format:

```ts
import type { Serde } from '@insler/serde';

const mySerde: Serde<string> = {
  encode(value: unknown): string {
    return JSON.stringify(value);
  },
  decode(wire: string): unknown {
    return JSON.parse(wire);
  },
};
```

## JSON serde

`jsonSerde` encodes values to JSON strings using [SuperJSON](https://github.com/flightcontrolhq/superjson), which preserves rich types like `Date`, `Map`, `Set`, `BigInt`, `RegExp`, and more.

```ts
import { jsonSerde } from '@insler/serde';

const wire = jsonSerde.encode({ createdAt: new Date(), tags: new Set(['a', 'b']) });
// '{"json":{"createdAt":"2024-01-01T00:00:00.000Z","tags":["a","b"]},"meta":...}'

const value = jsonSerde.decode(wire);
// { createdAt: Date, tags: Set(['a', 'b']) }
```

Encoding `undefined` produces an empty string, and decoding an empty string returns `undefined`.

## JSON bytes serde

`jsonBytesSerde` wraps `jsonSerde` to produce `Uint8Array` output, suitable for binary transports like NATS.

```ts
import { jsonBytesSerde } from '@insler/serde';

const bytes = jsonBytesSerde.encode({ count: 42 });
// Uint8Array

const value = jsonBytesSerde.decode(bytes);
// { count: 42 }
```

## Custom serde

Implement the `Serde` interface to use any serialization format (MessagePack, Protobuf, CBOR, etc.):

```ts
import type { Serde } from '@insler/serde';
import { encode, decode } from '@msgpack/msgpack';

const msgpackSerde: Serde<Uint8Array> = {
  encode: (value) => encode(value),
  decode: (wire) => decode(wire),
};
```

Pass your custom serde to transport constructors that accept a `serde` option.

## License

MIT
