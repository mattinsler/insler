# insler

A monorepo home for a collection of small, composable TypeScript libraries,
published under the `@insler/*` namespace.

## Packages

<!-- packages:start -->
| Package | Description |
| --- | --- |
| `@insler/di` | A lightweight, type-safe dependency injection container for TypeScript |
| `@insler/rpc-client` | Fully-typed RPC caller derived from an @insler contract — throw/result error modes, scoped clients, and a kind-discriminated middleware pipeline over pluggable transports. |
| `@insler/rpc-context` | Context propagation for @insler RPC — moves per-request context (e.g. identity) into and out of request metadata via a serde-backed Propagator. |
| `@insler/rpc-contract` | The @insler RPC contract — a deeply-frozen, versioned, zod-typed API definition that both client and host derive their types and runtime behavior from. |
| `@insler/rpc-host` | The server side of @insler RPC — registers validated handlers on a transport with zod input/output validation, context extraction, error normalization, and middleware. |
| `@insler/rpc-otel` | OpenTelemetry tracing for @insler RPC, delivered as client and host middleware, with W3C traceparent format/parse helpers. |
| `@insler/rpc-transport-memory` | In-process transport for @insler RPC — routes calls over a shared MemoryBus; backs the test helpers and single-process multi-service (monolith) mode. |
| `@insler/rpc-transport-nats` | NATS transport for @insler RPC — unary + streaming (serverStream/clientStream/duplex) over core NATS with credit-based flow control, plus an ADR-32 discovery plane so the standard `nats micro` CLI can find, ping, and stat services. |
| `@insler/serde` | The Serde encode/decode interface for @insler RPC, plus baseline SuperJSON-based JSON serdes (string and Uint8Array). Zero dependencies — the bottom of the stack. |
| `@insler/serde-avro` | Avro Serde<Uint8Array> implementation for @insler RPC, backed by avsc. |
| `@insler/serde-cbor` | CBOR Serde<Uint8Array> implementation for @insler RPC, backed by cbor2. |
| `@insler/serde-json` | Standalone SuperJSON-based JSON Serde for @insler RPC, preserving rich types (Date/Map/Set/BigInt). |
| `@insler/serde-msgpack` | MessagePack Serde<Uint8Array> implementation for @insler RPC, backed by @msgpack/msgpack. |
| `@insler/service` | Env-aware convenience layer over @insler host and client (environment detection, auto dev-mode logging, handler-completeness validation, in-process test pairs) — and the home of the service declaration model: the ephemeral/persistent/workflow kind taxonomy and, ahead, defineService. |
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
