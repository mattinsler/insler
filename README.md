# @insler

Small, composable TypeScript projects, published as libraries under the
`@insler/*` namespace.

## Projects

Each project lives in its own directory under [`packages/`](./packages) and
stands on its own — use one, or compose them.

<!-- packages:start -->
### [rpc](./packages/rpc) — Contract-first RPC for TypeScript

Define a service's API once as a typed, versioned **contract** — methods, zod input/output schemas, per-request context, typed errors — and derive both sides from it: a fully-typed **client** for callers and a validating **host** for handlers, connected by a pluggable **transport**. Develop, test, and run as a monolith with the in-memory transport; the NATS adapter takes the same service onto the network unchanged.

**Docs:** [rpc.insler.dev](https://rpc.insler.dev)

| Package | Description |
| --- | --- |
| `@insler/rpc` | The @insler RPC framework in one package — typed contracts, client, host, per-request context, and the in-memory transport, each importable as its own subpath entrypoint (/contract, /context, /client, /host, /transport-memory). |
| `@insler/rpc-otel` | OpenTelemetry tracing for @insler RPC, delivered as client and host middleware, with W3C traceparent format/parse helpers. |
| `@insler/rpc-transport-nats` | NATS transport for @insler RPC — unary and streaming calls over core NATS with credit-based flow control, discoverable with the standard `nats micro` CLI, plus a leaf-node helper for local development. |

### [serde](./packages/serde) — Pluggable wire serialization for TypeScript

One tiny interface — **`Serde<Wire>`**: `encode` a value to a wire format, `decode` it back — and format adapters that implement it: JSON (SuperJSON-backed, rich types survive), MessagePack, CBOR, and Avro. Anything that moves values over a wire takes a `Serde` — the `@insler/rpc` transports take one as their `serde` option — so swapping the format is a one-argument change, never a call-site rewrite. The zero-dependency core owns the interface; each format binding is its own adapter package.

**Docs:** [serde.insler.dev](https://serde.insler.dev)

| Package | Description |
| --- | --- |
| `@insler/serde` | The Serde encode/decode interface for @insler RPC, plus baseline SuperJSON-based JSON serdes (string and Uint8Array). Zero dependencies — the bottom of the stack. |
| `@insler/serde-avro` | Avro Serde<Uint8Array> implementation for @insler RPC, backed by avsc. |
| `@insler/serde-cbor` | CBOR Serde<Uint8Array> implementation for @insler RPC, backed by cbor2. |
| `@insler/serde-json` | Standalone SuperJSON-based JSON Serde for @insler RPC, preserving rich types (Date/Map/Set/BigInt). |
| `@insler/serde-msgpack` | MessagePack Serde<Uint8Array> implementation for @insler RPC, backed by @msgpack/msgpack. |

### [service](./packages/service) — Typed service definitions for the @insler RPC stack

Wrap an RPC contract and its handlers in a **service** that knows its environment — automatic dev-mode logging, handler-completeness validation, in-process test pairs — and declare what it needs to run with **`defineService`**: a typed, statically-analyzable record of the service's identity, dependencies, scale, and exposure that the platform compiles into deployment artifacts.

**Docs:** [service.insler.dev](https://service.insler.dev)

| Package | Description |
| --- | --- |
| `@insler/service` | Env-aware service layer over the @insler RPC client and host (environment detection, dev-mode logging, handler-completeness validation, in-process test pairs), plus defineService — the typed declaration of a service's deployment intent. |

### [platform](./packages/platform) — Infrastructure from code

Turn `defineService` declarations into running infrastructure. The `insler` CLI scans your services into a desired-state model, generates deployment artifacts through a plugin-based generator — Kubernetes, autoscaling, edge routing, secret bindings — and reconciles with plan/diff applies: auto-converge in development, gated and audited in production.

| Package | Description |
| --- | --- |
| `@insler/cli` | The insler CLI — scan service declarations, generate deployment artifacts, and plan/apply reconciliation: auto-converge in development, gated and audited in production. |
| `@insler/platform` | The insler platform in one package — fleet scanning and a desired-state model, a pluggable deployment-artifact generator, and a plan/diff reconciler, each importable as its own subpath entrypoint (/fleet, /generator, /reconciler). |

### [di](./packages/di) — Typed dependency injection for TypeScript

Declare your application's pieces as typed **tokens**, bind each one with a factory in a **container**, and let the container resolve the graph: independent bindings in parallel, every value fully typed at the point of use, no decorators and no reflection. Pair a value with its cleanup via the **managed** lifecycle and shutdown runs in reverse dependency order; wrap a factory in **singleton** to share reference-counted resources across containers. di is fully standalone — it depends on nothing else in this repo.

**Docs:** [di.insler.dev](https://di.insler.dev)

| Package | Description |
| --- | --- |
| `@insler/di` | A lightweight, type-safe dependency injection container for TypeScript |
<!-- packages:end -->

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
