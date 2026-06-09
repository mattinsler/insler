# @insler/serde-json

Standalone [SuperJSON](https://github.com/flightcontrolhq/superjson)-based JSON serde for `@insler` RPC, preserving rich types (`Date`, `Map`, `Set`, `BigInt`, `RegExp`, and more) across the wire.

It provides two `Serde` implementations:

- `jsonSerde` — `Serde<string>`, JSON strings.
- `jsonBytesSerde` — `Serde<Uint8Array>`, UTF-8 bytes for binary transports.

## Install

```sh
bun add @insler/serde-json
```

## String serde

`jsonSerde` encodes values to JSON strings with SuperJSON, so rich types survive the roundtrip.

```ts
import { jsonSerde } from '@insler/serde-json';

const wire = jsonSerde.encode({ createdAt: new Date(), tags: new Set(['a', 'b']) });
// SuperJSON string

const value = jsonSerde.decode(wire);
// { createdAt: Date, tags: Set(['a', 'b']) }
```

Encoding `undefined` produces an empty string, and decoding an empty string returns `undefined`.

## Bytes serde

`jsonBytesSerde` wraps `jsonSerde` to produce `Uint8Array` output, suitable for binary transports like NATS or WebSocket.

```ts
import { jsonBytesSerde } from '@insler/serde-json';

const bytes = jsonBytesSerde.encode({ count: 42 });
// Uint8Array

const value = jsonBytesSerde.decode(bytes);
// { count: 42 }
```

## License

MIT
