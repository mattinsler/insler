# service — Typed service definitions for the @insler RPC stack

Wrap an RPC contract and its handlers in a **service** that knows its
environment — automatic dev-mode logging, handler-completeness validation,
in-process test pairs — and declare what it needs to run with
**`defineService`**: a typed, statically-analyzable record of the service's
identity, dependencies, scale, and exposure that the platform compiles into
deployment artifacts.

**Full documentation: [service.insler.dev](https://service.insler.dev)**

## Install

One install yields both roles — the runtime wrapper and the declaration model ship together in
the single-entrypoint package, and it brings the `@insler/rpc` core (contracts, clients, hosts,
transports) along with it:

```sh
bun add @insler/service
```

Its runtime dependencies are exactly `@insler/rpc` and `std-env` — nothing heavier.

## A minimal service

Author the contract with the rpc core, then serve it env-aware:

```ts
import { Contract } from '@insler/rpc/contract';
import { createMemoryTransport } from '@insler/rpc/transport-memory';
import { Service } from '@insler/service';
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

const transport = createMemoryTransport();
const service = await Service.create(GreeterContract, {
  greet: async ({ name }) => ({ message: `Hello, ${name}!` }),
}, transport.host);

service.env; // 'development' | 'test' | 'production' — detected, or overridden via options
await service.stop();
```

In development, logging middleware is applied automatically; outside production, a missing
handler throws at startup instead of failing at call time. Swap the in-memory transport for a
real one (e.g. the rpc subsystem's NATS transport) without touching the handlers.

Then declare how the service deploys — literal intent only, extractable without executing the
service:

```ts
import { defineService } from '@insler/service';

export const greeter = defineService({
  name: 'greeter',
  kind: 'ephemeral', // holds nothing between requests — may scale to zero
  contract: GreeterContract,
  needs: ['valkey'], // logical resources, never connection strings
  scale: { on: 'queue-depth', min: 0, max: 20 },
});
```

The result is a deeply-frozen `ServiceDef`: validation throws at declaration time, defaults
resolve onto always-present `effective*` projections, and `toJSON()` yields the static view the
platform's generator consumes.

## What's in this directory

### The umbrella package — `@insler/service` ([`service/`](./service/README.md))

service is a single-entrypoint core: the root import is the whole public surface.

| Entrypoint        | Purpose                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `@insler/service` | The env-aware runtime wrapper (`Service.create`: environment detection, dev logging, handler-completeness validation) and the deployment-intent declaration model (`defineService`, the `ephemeral`/`persistent`/`workflow` kind taxonomy, `deriveIdentity`, needs/calls/scale/isolation/expose) |

### Adapter packages

None — service has no adapter packages. It is policy over the rpc core, not a binding to a
third-party system: the transports a service runs over are the
[rpc subsystem](https://rpc.insler.dev)'s adapters (e.g. `@insler/rpc-transport-nats`), and the
platform layers that consume a declaration live in `@insler/platform`.

## Where to go next

- [service.insler.dev](https://service.insler.dev) — getting started and the full docs for the
  runtime wrapper, the kind taxonomy, and every declaration axis.
- [`service/README.md`](./service/README.md) — the package's complete API walkthrough.
- The contract, client, host, and transports underneath come from the
  [rpc subsystem](https://rpc.insler.dev) (`@insler/rpc`); the layers that compile a
  `ServiceDef` into running fleets are the platform subsystem (`@insler/platform`).
