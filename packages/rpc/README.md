# rpc — Contract-first RPC for TypeScript

Define a service's API once as a typed, versioned **contract** — methods, zod input/output
schemas, per-request context, typed errors — and derive both sides from it: a fully-typed
**client** for callers and a validating **host** for handlers, connected by a pluggable
**transport**. Develop, test, and run as a monolith with the in-memory transport; the NATS
adapter takes the same service onto the network unchanged.

**Full documentation: [rpc.insler.dev](https://rpc.insler.dev)**

## Install

One install yields a working in-process service — contract, client, host, and the in-memory
transport ship together in the umbrella package:

```sh
bun add @insler/rpc
```

Its runtime dependencies are exactly `zod` and the zero-dependency `@insler/serde` — nothing
heavier. Add an adapter package only when you need the system it binds (e.g.
`@insler/rpc-transport-nats` to go networked).

## A minimal service

```ts
import { Client, Contract, createMemoryTransport, Host } from '@insler/rpc';
import { z } from 'zod';

const Calculator = Contract.create('calculator', {
  version: '1.0.0',
  methods: {
    add: {
      input: z.object({ a: z.number(), b: z.number() }),
      output: z.object({ result: z.number() }),
    },
  },
});

const handlers: Contract.Handlers<typeof Calculator> = {
  add: async ({ a, b }) => ({ result: a + b }),
};

const { client: clientTransport, host: hostTransport } = createMemoryTransport();
await Host.create(Calculator, handlers, hostTransport);
const calculator = Client.create(Calculator, clientTransport);

await calculator.add({ a: 3, b: 4 }); // { result: 7 }
```

The root `@insler/rpc` entrypoint re-exports this 0-to-value surface; the subpath entrypoints
below are the canonical import path per layer, and each is separately compiled — importing one
loads no code from the others.

## What's in this directory

### The umbrella package — `@insler/rpc` ([`rpc/`](./rpc/README.md))

| Entrypoint                     | Purpose                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `@insler/rpc/contract`         | `Contract.create` — the frozen, versioned API surface (methods, zod schemas, context, typed errors) both sides derive from |
| `@insler/rpc/context`          | Propagators that move per-request context (e.g. identity) into and out of request metadata                   |
| `@insler/rpc/client`           | `Client.create` — the fully-typed caller: throw or result mode, scoped clients, middleware                   |
| `@insler/rpc/client/dev`       | Logging and timing middleware for development clients                                                        |
| `@insler/rpc/client/test`      | `TestTransport` for unit-testing client logic without a host                                                 |
| `@insler/rpc/host`             | `Host.create` — the server side: validates I/O against the contract, extracts context, runs handlers, normalizes errors |
| `@insler/rpc/host/dev`         | Logging middleware and handler validation for development hosts                                              |
| `@insler/rpc/host/test`        | `TestHost.pair` — an in-process host + client pair, the default integration seam                             |
| `@insler/rpc/transport-memory` | The in-process transport backing local dev, tests, and monolith mode                                         |

### Adapter packages

Anything that exists to bind a third-party system stays out of the umbrella and is its own
package in this directory:

| Package                                                                    | Purpose                                                                                              |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `@insler/rpc-transport-nats` ([`rpc-transport-nats/`](./rpc-transport-nats/README.md)) | NATS wire transport for all four method kinds (unary + streaming) with queue-group load balancing and a `nats micro`-compatible discovery plane |
| `@insler/rpc-otel` ([`rpc-otel/`](./rpc-otel/README.md))                    | OpenTelemetry tracing as client and host middleware, plus W3C traceparent helpers                    |

## Where to go next

- [rpc.insler.dev](https://rpc.insler.dev) — getting started and the full docs for every
  entrypoint and adapter.
- Each package's own README (linked above) for its complete API surface.
- Swapping the wire format? The serialization interface and its formats (JSON, MessagePack,
  CBOR, Avro) live in the [serde subsystem](https://serde.insler.dev) (`@insler/serde`,
  `@insler/serde-*`).
- Building deployable services on top? The [service subsystem](https://service.insler.dev)
  (`@insler/service`) wraps client and host with environment-aware defaults.
