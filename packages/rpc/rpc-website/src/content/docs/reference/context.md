---
title: '@insler/rpc/context'
description: Propagators that move per-request context (e.g. identity) into and out of request metadata.
sidebar:
  order: 2
---

**Context** is per-request metadata — an identity, a tenant, a trace — defined
by zod schemas on the contract, separate from method input. This entrypoint
owns the `Propagator` abstraction that moves context values into and out of a
string-keyed carrier (request metadata):

```ts
import { createPropagator, type Propagator } from '@insler/rpc/context';
import { jsonSerde } from '@insler/serde';

const propagator: Propagator = createPropagator(jsonSerde);

const carrier: Record<string, string> = {};
propagator.inject({ identity: { userId: 'u_1' } }, carrier);
propagator.extract(['identity'], carrier); // { identity: { userId: 'u_1' } }
```

- `inject(context, carrier)` encodes each context value via the serde.
- `extract(keys, carrier)` decodes only the keys you ask for — driven by the
  contract's context schema keys.

## What it does not own

What context *means* lives on the contract (`/contract`); the wire serde
itself is `@insler/serde`; validation happens on the host. This layer only
maps `Record<string, unknown>` to `Record<string, string>` metadata and back.

## Use it well

The client and host each default to a JSON-stringify propagator and accept a
`propagator` option. Supply a custom one when context encoding must differ —
for example, trace headers in a specific wire format.
