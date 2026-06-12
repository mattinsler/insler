---
title: '@insler/rpc-transport-nats'
description: NATS wire transport for all four method kinds, with queue-group load balancing and a nats-micro-compatible discovery plane.
sidebar:
  order: 10
---

The NATS adapter package — the full wire protocol for the framework over
**core NATS** (no JetStream required). It exists to bind NATS, so it stays
out of the umbrella per the core/adapter rule.

```sh
bun add @insler/rpc-transport-nats
```

```ts
import { connect } from '@nats-io/transport-node';
import { createNatsTransport } from '@insler/rpc-transport-nats';

const connection = await connect({ servers: 'nats://localhost:4222' });
const { client, host } = createNatsTransport({ connection });

// the same contract, handlers, and Client/Host calls as in-process —
// only the transport changed.
```

## The RPC plane

- **All four method kinds**: unary request/reply plus `serverStream`,
  `clientStream`, and `duplex` streaming with credit-based flow control,
  per-direction sequence gap detection, idle timeouts, optional deadlines,
  and cancellation.
- **Subjects**: `{subjectPrefix}.{service}.{method}` (default prefix `rpc`).
- **Load balancing**: queue groups (default `q`) spread calls across
  instances.
- **Pluggable serde**: pass any `Serde<Uint8Array>` (default
  `jsonBytesSerde`) — CBOR, MessagePack, and Avro stream without
  special-casing.
- **Failures surface as typed error tags**, never throws: `__timeout__`,
  `__transport__`, `__serde__`, `__validation__`, `__unknown__`.

Streaming behavior is observably identical to the in-memory transport for
the same call: develop on memory, deploy on NATS.

## The discovery plane

Each registered service answers the standard `$SRV.PING` / `$SRV.INFO` /
`$SRV.STATS` subjects with verbatim `io.nats.micro.v1.*` schemas, so the
stock `nats micro` CLI discovers, pings, and stats your services with no
extra tooling. Control-plane responses are always plain JSON, independent of
the application serde.

## Dev-cluster leaf nodes

`startLeafNode({ remotes })` runs a local `nats-server` leaf that joins a
shared dev cluster, so one or two locally-run services participate in the
same queue groups as the remote fleet.

## Use it well

The caller owns the `NatsConnection` lifecycle. Bound in-flight streaming
buffers with a small `credit`; cap long-lived streams with `deadline`. Test
wire-format, serde, queue, and discovery behavior here against a real NATS
server — not against the memory transport.
