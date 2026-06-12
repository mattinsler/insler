---
title: '@insler/rpc/host'
description: 'Host.create — the server side: validates I/O against the contract, extracts context, runs handlers, normalizes errors.'
sidebar:
  order: 6
---

The server side. `Host.create(contract, handlers, transport, options?)`
registers validated handlers on a `HostTransport` and returns a
`HostInstance` (`{ stop() }`).

```ts
import { Contract } from '@insler/rpc/contract';
import { Host } from '@insler/rpc/host';

const handlers: Contract.Handlers<typeof Accounts> = {
  getBalance: async ({ identity }, { accountId }) => {
    // context first (when the method has context schemas), then input
    return { balance: 42 };
  },
  watchBalance: async function* ({ identity }, { accountId }) {
    yield { balance: 42 };
  },
};

const host = await Host.create(Accounts, handlers, hostTransport);
// ... later
await host.stop();
```

## What the host guarantees

- **Validation.** Inputs and outputs are validated against the contract's
  zod schemas; failures surface as the reserved `__validation__` error.
- **Context extraction.** Per-request context is pulled from request metadata
  via a `Propagator` (JSON by default, `options.propagator` to override).
- **Error normalization.** A handler throw carrying a `_tag` becomes that
  typed contract error; anything else is stripped to `__unknown__` — internal
  details never leak to callers.
- **Completeness.** Missing a handler for any contract method throws at
  `Host.create` time, not at first call.

## Handler shape

Handlers receive `(context?, input?)` — the context argument is present only
when the method or contract declares context schemas, and the input argument
is absent for `void` input. Throw `{ _tag, payload }` for contract errors.

## Middleware

`options.middleware` wraps handlers with a composed chain
(`composeMiddleware`); validation, context extraction, and exception safety
stay inside the envelope. Coverage today is partial: `unary` and
`serverStream` handlers are wrapped, `clientStream` and `duplex` are
registered without middleware until streaming middleware coverage lands.

## Secondary entrypoints

- `@insler/rpc/host/test` — `TestHost.pair`, the default integration seam.
- `@insler/rpc/host/dev` — logging middleware and handler validation for
  development.
