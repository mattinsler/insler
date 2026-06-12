---
title: Getting started
description: From `bun add @insler/rpc` to a working in-process service in minutes.
---

This guide takes you from one install to a working, fully-typed, validated
in-process service — and shows where to go when you need the network.

## 1. Install

```sh
bun add @insler/rpc
```

That one package contains everything this guide uses: the contract layer, the
client, the host, and the in-memory transport. Its runtime dependencies are
exactly `zod` and the zero-dependency `@insler/serde`.

## 2. Define the contract

The contract is the single source of truth both sides derive from: methods,
zod input/output schemas, and typed errors, frozen and versioned.

```ts
import { Contract } from '@insler/rpc';
import { z } from 'zod';

export const Calculator = Contract.create('calculator', {
  version: '1.0.0',
  methods: {
    add: {
      input: z.object({ a: z.number(), b: z.number() }),
      output: z.object({ result: z.number() }),
    },
    divide: {
      input: z.object({ a: z.number(), b: z.number() }),
      output: z.object({ result: z.number() }),
      errors: {
        divide_by_zero: z.object({ a: z.number() }),
      },
    },
  },
});
```

`Contract.create` returns a deeply-frozen `ContractDef`. You never hand-write
handler or client signatures — they are inferred from this definition.

## 3. Implement the handlers

`Contract.Handlers<typeof Calculator>` is the exact handler surface the
contract demands — every method, with typed input and output. Throw a
`{ _tag, payload }` object to raise a typed contract error.

```ts
import { Contract } from '@insler/rpc';

const handlers: Contract.Handlers<typeof Calculator> = {
  add: async ({ a, b }) => ({ result: a + b }),
  divide: async ({ a, b }) => {
    if (b === 0) throw { _tag: 'divide_by_zero', payload: { a } };
    return { result: a / b };
  },
};
```

## 4. Serve it and call it

The in-memory transport runs client and host in one process — the default for
development, tests, and monolith mode. `Host.create` validates every request
and response against the contract; `Client.create` derives the typed calls.

```ts
import { Client, createMemoryTransport, Host } from '@insler/rpc';

const { client: clientTransport, host: hostTransport } = createMemoryTransport();

await Host.create(Calculator, handlers, hostTransport);
const calculator = Client.create(Calculator, clientTransport);

await calculator.add({ a: 3, b: 4 }); // { result: 7 }
```

Missing a handler for any contract method throws at `Host.create` time, and
inputs that fail the zod schemas never reach your handlers.

## 5. Handle typed errors

By default the client throws a `ContractError`. Pass `errors: 'result'` to
get a result-mode client that returns `{ ok, value } | { ok, error }` with
the error union typed per method:

```ts
const calc = Client.create(Calculator, clientTransport, { errors: 'result' });

const division = await calc.divide({ a: 1, b: 0 });
if (!division.ok) {
  division.error; // typed: { _tag: 'divide_by_zero', payload: { a: number } } | ...
}
```

## Where to go next

- **Go networked.** Swap `createMemoryTransport()` for
  [`@insler/rpc-transport-nats`](/reference/rpc-transport-nats/) — the same
  contract, handlers, and client move onto NATS unchanged, with queue-group
  load balancing and all four method kinds.
- **Test it.** [`@insler/rpc/host/test`](/reference/host-test/) gives you
  `TestHost.pair` — an in-process host + client pair, the default integration
  seam.
- **Learn the layers.** The [reference](/reference/contract/) has one page
  per umbrella entrypoint and per adapter package.
