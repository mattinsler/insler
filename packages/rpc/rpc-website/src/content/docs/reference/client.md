---
title: '@insler/rpc/client'
description: 'Client.create — the fully-typed caller derived from the contract: throw or result mode, scoped clients, middleware.'
sidebar:
  order: 3
---

The caller side. `Client.create(contract, transport, options?)` builds a
fully-typed client whose methods are derived from the contract; the wire it
calls through is any `ClientTransport` — the in-memory transport or an
adapter like NATS.

```ts
import { Client } from '@insler/rpc/client';

const accounts = Client.create(Accounts, clientTransport);
await accounts.getBalance({ accountId: 'a_1' }); // { balance: number }
```

## Error modes

- **Throw mode** (default): a failed call throws `ContractError` — best
  ergonomics.
- **Result mode** (`errors: 'result'`): calls return
  `{ ok, value } | { ok, error }` with the error union typed per method —
  handle typed errors without try/catch.

## Scoped clients

`Client.withContext(client, ctx)` returns a **scoped client** with context
pre-applied (works in both error modes):

```ts
const asUser = Client.withContext(accounts, { identity: { userId: 'u_1' } });
await asUser.getBalance({ accountId: 'a_1' });
```

## Middleware

`options.middleware` composes cross-cutting per-call logic (auth, logging,
timing) via `composeMiddleware`; middleware executes in array order,
outermost first. Coverage today is partial: `unary` and `serverStream` calls
route through the chain, while `clientStream` and `duplex` still call the
transport directly — do not assume uniform coverage on streaming interceptors
yet.

## Secondary entrypoints

- `@insler/rpc/client/test` — `TestTransport` for unit-testing client logic
  without a host.
- `@insler/rpc/client/dev` — logging and timing middleware for development.

## Use it well

Let the contract infer method signatures — never hand-type them. Keep
business validation on the host, not in client middleware. Streaming methods
require a transport that implements the matching stream invocation; absence
throws a clear error.
