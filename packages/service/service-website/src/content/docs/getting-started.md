---
title: Getting started
description: From `bun add @insler/service` to an env-aware served contract and a typed deployment declaration.
---

This guide takes you from one install to a contract served with
environment-aware policy, then declares how that service deploys.

## 1. Install

```sh
bun add @insler/service
```

That one package contains both roles this guide uses: the env-aware runtime
wrapper and the `defineService` declaration model. Its runtime dependencies
are exactly `@insler/rpc` (the contract/client/host core, which the install
brings with it) and `std-env`.

## 2. Author a contract

The contract comes from the rpc core — methods, zod schemas, versioning. It
is the shared truth the service serves and its callers derive clients from:

```ts
import { Contract } from '@insler/rpc/contract';
import { z } from 'zod';

const GreeterContract = Contract.create('greeter', {
  version: '1.0.0',
  methods: {
    greet: {
      input: z.object({ name: z.string() }),
      output: z.object({ message: z.string() }),
    },
  },
});
```

## 3. Serve it env-aware

`Service.create(contract, handlers, transport)` wraps the rpc host with
environment policy. The transport is injected — start in-memory:

```ts
import { createMemoryTransport } from '@insler/rpc/transport-memory';
import { Service } from '@insler/service';

const transport = createMemoryTransport();

const service = await Service.create(GreeterContract, {
  greet: async ({ name }) => ({ message: `Hello, ${name}!` }),
}, transport.host);

service.env; // 'development' | 'test' | 'production'
```

Three things happened that a raw host would not do:

- **Environment detection.** `service.env` is detected from the runtime
  (`NODE_ENV`, test runners) via `std-env`, falling back to `production`.
  Override it in ambiguous runtimes: `Service.create(..., { env: 'production' })`.
- **Handler completeness.** Outside production, a missing handler throws at
  startup — not at the first unlucky call.
- **Dev-mode logging.** In development, logging middleware is applied
  automatically; add your own via `options.middleware`.

Call it with a plain rpc client over the same transport:

```ts
import { Client } from '@insler/rpc/client';

const client = Client.create(GreeterContract, transport.client);
await client.greet({ name: 'Ada' }); // { message: 'Hello, Ada!' }

await service.stop();
```

Swapping the in-memory transport for the [rpc subsystem](https://rpc.insler.dev)'s
NATS transport is a one-argument change — the contract and handlers never move.

## 4. Declare how it deploys

`defineService` wraps the same contract with the service's operational
intent — literal, statically analyzable, validated at declaration time:

```ts
import { defineService } from '@insler/service';

export const greeter = defineService({
  name: 'greeter',
  kind: 'ephemeral', // holds nothing between requests — may scale to zero
  contract: GreeterContract,
  needs: ['valkey'], // logical resource names, never connection strings
  scale: { on: 'queue-depth', min: 0, max: 20 },
});
```

The `kind` is the one lifecycle question: does the service hold state or
work *between* requests? **No** → `ephemeral` (may scale to zero — a long
server-stream is still one request). **Yes** → `persistent` (replica floor
≥ 1). **`workflow`** is a durable orchestration worker: it requires a
`taskQueue` and inherits `persistent`'s profile. Transport is orthogonal —
exposing HTTP routes never changes the kind.

The result is a deeply-frozen `ServiceDef`. Defaults resolve onto
always-present projections (`effectiveScale`, `effectiveIsolation`,
`needRefs` / `callRefs` / `exposeRoutes`), and `toJSON()` reduces the live
contract to its `{ kind, version }` identity so the platform's generator can
consume the declaration without executing your service. Put declarations in
`*.service.ts` / `*.def.ts` files — that is how the platform's fleet scanner
discovers them.

## 5. Identity is derived, not declared

Every downstream concern — credentials, secret paths, workload identity,
telemetry attribution — keys on the service's identity, derived
deterministically from the declared name and the environment:

```ts
import { deriveIdentity } from '@insler/service';

const identity = deriveIdentity(greeter, 'production');
identity.qualifiedName; // 'prod.default.greeter'
```

Namespaced names split naturally: a service named `'commerce.orders'`
derives `prod.commerce.orders`.

## Where to go next

- **The full surface.** [`@insler/service`](/reference/service/) — the
  runtime wrapper, the kind taxonomy, and every declaration axis with its
  validation and projection.
- **The stack underneath.** The [rpc subsystem](https://rpc.insler.dev) owns
  contracts, clients, hosts, and transports — and the rest of the
  [insler.dev](https://insler.dev) family composes the same way.
