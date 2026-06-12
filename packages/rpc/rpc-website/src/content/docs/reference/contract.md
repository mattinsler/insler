---
title: '@insler/rpc/contract'
description: Contract.create — the frozen, versioned API surface (methods, zod schemas, context, typed errors) both sides derive from.
sidebar:
  order: 1
---

The **contract** is the single source of truth both sides derive from.
`Contract.create(kind, props)` returns a deeply-frozen, versioned
`ContractDef`: normalized methods, zod input/output schemas (default
`z.void()`), contract- or method-level **context** schemas, and typed
**errors**. This entrypoint is pure definition plus type inference — no
calling, no serving, no transport, no serde.

```ts
import { Contract } from '@insler/rpc/contract';
import { z } from 'zod';

const Accounts = Contract.create('accounts', {
  version: '1.0.0',
  context: { identity: z.object({ userId: z.string() }) },
  methods: {
    getBalance: {
      input: z.object({ accountId: z.string() }),
      output: z.object({ balance: z.number() }),
      errors: { not_found: z.object({ accountId: z.string() }) },
    },
    watchBalance: {
      kind: 'serverStream',
      input: z.object({ accountId: z.string() }),
      output: z.object({ balance: z.number() }),
    },
  },
});
```

## Method kinds

Every method is one of four kinds: `unary` (the default), `serverStream`,
`clientStream`, or `duplex`. Transports implement the wire behavior; the
contract only declares the shape.

## The type machinery

The `Contract.*` namespace derives every signature you would otherwise
hand-write:

- `Contract.Handlers<C>` — the exact handler surface a host requires.
- `Contract.Client<C>` / `Contract.ScopedClient<C>` — the typed call surface,
  with or without context pre-applied.
- `Contract.ResultClient<C>` / `Contract.ResultScopedClient<C>` — result-mode
  variants returning `{ ok, value } | { ok, error }`.
- `Contract.MethodContext<C, M>` — the context a method receives.
- `Contract.Errors<C, M>` — the `{ _tag; payload }` union a method can raise.

## Use it well

- Define the API surface here once; let `/client`, `/host`, and
  `@insler/service` infer handler and call signatures from it.
- A method-level `context: {}` overrides contract-level context to "none".
- `ContractDef` is frozen — never mutate one.
- Schemas are zod; keep them there rather than wrapping another validator.
