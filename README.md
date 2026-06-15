# insler

Small, composable TypeScript projects, published as libraries under the
`@insler/*` namespace.

These libraries share a point of view:

- **Contracts are the source of truth.** Define a service's API once — typed
  methods, zod schemas, typed errors — and derive everything else from it:
  clients, hosts, validation.
- **Develop as a monolith, deploy as services.** Every seam that touches the
  network is pluggable. Run everything in-process with the in-memory
  transport; take the same code onto the network by swapping one binding.
- **No magic.** No decorators, no reflection, no runtime codegen. Everything
  is plain TypeScript that your editor and your reviewers can follow.
- **Every package stands alone.** Use one, or compose them.

## A taste

A service is a contract plus handlers. Both sides derive from the contract —
the client is fully typed, the host validates:

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

const { client: clientTransport, host: hostTransport } = createMemoryTransport();
await Host.create(Calculator, { add: async ({ a, b }) => ({ result: a + b }) }, hostTransport);
const calculator = Client.create(Calculator, clientTransport);

await calculator.add({ a: 3, b: 4 }); // { result: 7 } — fully typed
```

Applications wire their pieces together with `@insler/di` — typed tokens,
factories, and lifecycle, with no decorators or reflection:

```ts
import { container, token, managed } from '@insler/di';

const Db = token<Database>('db');

const app = await container()
  .provide(Db, async () => {
    const conn = await connect('postgres://localhost');
    return managed(conn, () => conn.close()); // cleanup runs on app.stop()
  })
  .start();

app.get(Db);
await app.stop(); // shutdown in reverse dependency order
```

Together they turn a pile of services into an application. The container owns
the transport, hosts, and clients as managed values — and because the
transport is just a binding, the same wiring runs as an in-process monolith
or across the network:

```ts
import { container, token, managed } from '@insler/di';
import { Client, Contract, createMemoryTransport, Host } from '@insler/rpc';
import type { ClientTransport, HostInstance, HostTransport } from '@insler/rpc';

const Transport = token<{ client: ClientTransport; host: HostTransport }>('transport');
const CalculatorHost = token<HostInstance>('calculator:host');
const Calc = token<Contract.Client<typeof Calculator>>('calculator:client');

const app = await container()
  .provide(Transport, () => createMemoryTransport())
  //         ^ swap this one binding for the NATS transport and the same
  //           services run across the network, unchanged
  .provide(CalculatorHost, [Transport], async ({ host }) => {
    const h = await Host.create(Calculator, { add: async ({ a, b }) => ({ result: a + b }) }, host);
    return managed(h, () => h.stop());
  })
  .provide(Calc, [Transport], ({ client }) => Client.create(Calculator, client))
  .start();

await app.get(Calc).add({ a: 3, b: 4 }); // { result: 7 }
```

## Projects

Each project lives in its own directory under [`packages/`](./packages) and
stands on its own.

<!-- packages:start -->
### [rpc](./packages/rpc) — Contract-first RPC for TypeScript

Define a service's API once as a typed, versioned **contract** — methods, zod input/output schemas, per-request context, typed errors — and derive both sides from it: a fully-typed **client** for callers and a validating **host** for handlers, connected by a pluggable **transport**. Develop, test, and run as a monolith with the in-memory transport; the NATS adapter takes the same service onto the network unchanged.

**Docs:** [packages/rpc/rpc/README.md](./packages/rpc/rpc/README.md)

| Package | Description |
| --- | --- |
| `@insler/rpc` | The @insler RPC framework in one package — typed contracts, client, host, per-request context, and the in-memory transport, each importable as its own subpath entrypoint (/contract, /context, /client, /host, /transport-memory). |
| `@insler/rpc-otel` | OpenTelemetry tracing for @insler RPC, delivered as client and host middleware, with W3C traceparent format/parse helpers. |
| `@insler/rpc-transport-nats` | NATS transport for @insler RPC — unary and streaming calls over core NATS with credit-based flow control, discoverable with the standard `nats micro` CLI, plus a leaf-node helper for local development. |

### [di](./packages/di) — Typed dependency injection for TypeScript

Declare your application's pieces as typed **tokens**, bind each one with a factory in a **container**, and let the container resolve the graph: independent bindings in parallel, every value fully typed at the point of use, no decorators and no reflection. Pair a value with its cleanup via the **managed** lifecycle and shutdown runs in reverse dependency order; wrap a factory in **singleton** to share reference-counted resources across containers. di is fully standalone — it depends on nothing else in this repo.

**Docs:** [packages/di/di/README.md](./packages/di/di/README.md)

| Package | Description |
| --- | --- |
| `@insler/di` | A lightweight, type-safe dependency injection container for TypeScript |

### [serde](./packages/serde) — Pluggable wire serialization for TypeScript

One tiny interface — **`Serde<Wire>`**: `encode` a value to a wire format, `decode` it back — and format adapters that implement it: JSON (SuperJSON-backed, rich types survive), MessagePack, CBOR, and Avro. Anything that moves values over a wire takes a `Serde` — the `@insler/rpc` transports take one as their `serde` option — so swapping the format is a one-argument change, never a call-site rewrite. The zero-dependency core owns the interface; each format binding is its own adapter package.

**Docs:** [packages/serde/serde/README.md](./packages/serde/serde/README.md)

| Package | Description |
| --- | --- |
| `@insler/serde` | The Serde encode/decode interface for @insler RPC, plus baseline SuperJSON-based JSON serdes (string and Uint8Array). Zero dependencies — the bottom of the stack. |
| `@insler/serde-avro` | Avro Serde<Uint8Array> implementation for @insler RPC, backed by avsc. |
| `@insler/serde-cbor` | CBOR Serde<Uint8Array> implementation for @insler RPC, backed by cbor2. |
| `@insler/serde-json` | Standalone SuperJSON-based JSON Serde for @insler RPC, preserving rich types (Date/Map/Set/BigInt). |
| `@insler/serde-msgpack` | MessagePack Serde<Uint8Array> implementation for @insler RPC, backed by @msgpack/msgpack. |
<!-- packages:end -->

## Roadmap

The RPC stack is the foundation for layers in active development, landing
here as they stabilize:

- **service** — an environment-aware service layer over contracts and hosts,
  and `defineService`: a typed, statically-analyzable declaration of a
  service's identity, dependencies, scale, and exposure.
- **platform** — infrastructure from code: a CLI that scans `defineService`
  declarations into a desired-state model and generates deployment artifacts
  through a plugin-based generator, with plan/diff reconciliation.
- **sandbox** — pluggable sandboxed execution (gVisor, libkrun, remote
  sandbox services) that integrates with service and platform.
- **workflows** — running any service contract as a durable workflow
  (Temporal-backed prototypes working today).

## Development

This repo uses [Bun](https://bun.sh).

```sh
bun install
bun run fmt
bun run lint
bun run typecheck
bun run test
```

## License

[MIT](./LICENSE)
