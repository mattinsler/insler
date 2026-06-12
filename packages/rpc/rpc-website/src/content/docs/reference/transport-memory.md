---
title: '@insler/rpc/transport-memory'
description: The in-process transport backing local dev, tests, and monolith mode.
sidebar:
  order: 9
---

The in-process transport — the dev/test default, shipped inside the umbrella
deliberately (zero external dependencies, batteries included).

```ts
import { createMemoryTransport } from '@insler/rpc/transport-memory';

const { bus, client, host } = createMemoryTransport();
```

- `MemoryBus` routes requests by `service.method` key. Duplicate registration
  for a key throws; invoking an unknown key returns a `__not_found__` error
  response.
- `MemoryClientTransport` / `MemoryHostTransport` implement the
  `ClientTransport` / `HostTransport` interfaces over a shared bus.
- `createMemoryTransport()` returns a connected `{ bus, client, host }`
  triple.

## When to use it

- **Tests** — directly, or via the higher-level `TestHost.pair` /
  `ServiceTest.pair` helpers that wrap it.
- **Local development** — run a service and its callers in one process.
- **Monolith mode** — run multiple services in one process by sharing a
  single `MemoryBus`.

Values pass in-process, so there is no serde here by design — when you need
wire encoding, that is the
[NATS adapter](/reference/rpc-transport-nats/)'s job. Streaming behavior
over a real wire is observably identical to this transport for the same
call: develop on memory, deploy on NATS.
