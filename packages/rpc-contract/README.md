# @insler/rpc-contract

Type-safe service contract definitions for TypeScript with support for:

- Zod-based input/output validation schemas
- Unary, server-stream, client-stream, and duplex method kinds
- Contract-level and per-method context schemas
- Typed error definitions per method
- Inferred handler, client, and scoped client types

## Install

```sh
bun add @insler/rpc-contract
```

## Defining a contract

A contract describes a service's API surface: its methods, their input/output schemas, and optional context and error types.

```ts
import { z } from 'zod';
import { Contract } from '@insler/rpc-contract';

const ModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  createdAt: z.date(),
});

const ModelRegistry = Contract.create('model-registry', {
  version: '1.0.0',
  context: {
    identity: z.object({
      userId: z.string(),
      orgId: z.string().optional(),
    }),
  },
  methods: {
    getModel: {
      input: z.object({ modelId: z.string() }),
      output: ModelSchema,
      errors: {
        NotFound: z.object({ modelId: z.string() }),
      },
    },
    listModels: {
      input: z.object({ provider: z.string().optional() }).optional(),
      output: z.object({ data: z.array(ModelSchema) }),
    },
    healthCheck: {
      context: {},
      output: z.object({ ok: z.boolean() }),
    },
  },
});
```

## Methods

Each method in a contract can specify:

- **kind** — `'unary'` (default), `'serverStream'`, `'clientStream'`, or `'duplex'`
- **input** — a Zod schema for the request payload (defaults to `z.void()`)
- **output** — a Zod schema for the response payload (defaults to `z.void()`)
- **errors** — a record of named error types, each with a Zod schema for its payload
- **context** — per-method context override (replaces the contract-level context for this method)
- **description** — an optional human-readable description

```ts
const Streaming = Contract.create('streaming', {
  version: '1.0.0',
  methods: {
    watchModels: {
      kind: 'serverStream',
      description: 'Watch for model changes.',
      output: ModelSchema,
    },
    uploadBatch: {
      kind: 'clientStream',
      input: z.object({ record: z.string() }),
      output: z.object({ count: z.number() }),
    },
  },
});
```

## Context

Context schemas define per-request metadata (like authentication identity) that is passed alongside method inputs. Define context at the contract level to apply it to all methods, or override it per method.

```ts
const contract = Contract.create('my-service', {
  version: '1.0.0',
  context: {
    identity: z.object({ userId: z.string() }),
  },
  methods: {
    getUser: {
      input: z.object({ id: z.string() }),
      output: z.object({ name: z.string() }),
    },
    healthCheck: {
      context: {},
      output: z.object({ ok: z.boolean() }),
    },
  },
});
```

The `getUser` handler receives `(context, input)` while `healthCheck` receives no context argument since its context is overridden to `{}`.

## Typed errors

Methods can declare typed error variants. These are surfaced at the type level through `Contract.Errors<>`.

```ts
const contract = Contract.create('accounts', {
  version: '1.0.0',
  methods: {
    transfer: {
      input: z.object({ from: z.string(), to: z.string(), amount: z.number() }),
      output: z.object({ transactionId: z.string() }),
      errors: {
        InsufficientFunds: z.object({ available: z.number() }),
        AccountNotFound: z.object({ accountId: z.string() }),
      },
    },
  },
});

type TransferErrors = Contract.Errors<typeof contract, 'transfer'>;
// { _tag: 'InsufficientFunds'; payload: { available: number } }
// | { _tag: 'AccountNotFound'; payload: { accountId: string } }
```

## Type utilities

The `Contract` namespace exports several type utilities for deriving handler and client signatures from a contract:

```ts
type Handlers = Contract.Handlers<typeof MyContract>;
type Client = Contract.Client<typeof MyContract>;
type ScopedClient = Contract.ScopedClient<typeof MyContract>;
type ResultClient = Contract.ResultClient<typeof MyContract>;
type ResultScopedClient = Contract.ResultScopedClient<typeof MyContract>;
type Ctx = Contract.MethodContext<typeof MyContract, 'getModel'>;
type Errs = Contract.Errors<typeof MyContract, 'getModel'>;
```

- **Handlers** — server-side handler signatures with context and input parameters
- **Client** — client-side call signatures (context + input)
- **ScopedClient** — client-side signatures with context pre-applied
- **ResultClient** — like Client but returns `{ ok, value } | { ok, error }` instead of throwing
- **ResultScopedClient** — like ScopedClient with result-mode errors

## Contract properties

The returned contract object is deeply frozen and exposes:

```ts
contract.type;       // 'contract'
contract.kind;       // the service name string
contract.version;    // the version string
contract.context;    // resolved context schemas
contract.methods;    // normalized method definitions (keyed by name)
contract.methodList; // frozen array of all method definitions
contract.schemas;    // optional shared schemas
```

## License

MIT
