# @insler/rpc

The @insler RPC framework in one package. Installing it yields a working in-process service —
typed contract, client, host, and the in-memory transport — with each layer importable as its own
subpath entrypoint:

| Entrypoint | Layer |
| --- | --- |
| `@insler/rpc/contract` | Frozen, versioned API surfaces: methods + zod schemas + context + typed errors |
| `@insler/rpc/context` | Per-request context propagation (propagators over request metadata) |
| `@insler/rpc/client` | Fully-typed caller — throw/result modes, scoped clients, middleware |
| `@insler/rpc/host` | Server side — contract validation, context extraction, handlers, typed errors |
| `@insler/rpc/transport-memory` | In-memory transport: local dev, tests, monolith mode |

Secondary entrypoints nest under their layer: `@insler/rpc/host/test` (TestHost),
`@insler/rpc/host/dev`, `@insler/rpc/client/test`, `@insler/rpc/client/dev`.

Each entrypoint is separately compiled — importing one loads no code from the others. The root
entrypoint re-exports the 0-to-value surface (contract + client + host + memory transport); the
subpaths are the canonical import style.

```ts
import { Client, Contract, createMemoryTransport, Host } from '@insler/rpc';
import { z } from 'zod';

const Calculator = Contract.create('calculator', {
  version: '1.0.0',
  methods: {
    add: {
      input: z.object({ a: z.number(), b: z.number() }),
      output: z.object({ result: z.number() }),
    },
  },
});

const { client: clientTransport, host: hostTransport } = createMemoryTransport();
await Host.create(Calculator, { add: async ({ a, b }) => ({ result: a + b }) }, hostTransport);
const calculator = Client.create(Calculator, clientTransport);

await calculator.add({ a: 3, b: 4 }); // { result: 7 }
```

Third-party integrations stay out of this package: wire transports
(`@insler/rpc-transport-nats`), observability (`@insler/rpc-otel`), and serialization formats
(`@insler/serde-*`) are separate adapter packages. Runtime dependencies here are exactly `zod`
and the zero-dependency `@insler/serde`.
