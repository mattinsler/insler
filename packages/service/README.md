# @insler/service

Environment-aware service and client wrappers for insler RPC with support for:

- Automatic environment detection (development, test, production)
- Development-mode logging and timing middleware
- Handler validation in non-production environments
- Service-level host and client creation
- In-process test pairs with handler validation

## Install

```sh
bun add @insler/service
```

## Creating a service host

`Service.create()` wraps `Host.create()` with environment-aware defaults:

```ts
import { Service } from '@insler/service';

const service = await Service.create(MyContract, {
  async getModel(ctx, { modelId }) {
    return await db.findModel(modelId);
  },
  async listModels(ctx) {
    return { data: await db.listModels() };
  },
}, transport);

console.log(service.env); // 'development' | 'test' | 'production'

await service.stop();
```

In development mode, logging middleware is automatically applied. In non-production environments, handler completeness is validated at startup — missing handlers throw immediately.

### Options

```ts
const service = await Service.create(MyContract, handlers, transport, {
  middleware: [myMiddleware],
  env: 'production', // override auto-detection
});
```

## Creating a service client

`ServiceClient.create()` wraps `Client.create()` with environment-aware middleware:

```ts
import { ServiceClient } from '@insler/service/client';

const client = ServiceClient.create(MyContract, transport);
```

In development mode, logging and timing middleware are automatically applied.

### Result-mode errors

```ts
const client = ServiceClient.create(MyContract, transport, { errors: 'result' });

const result = await client.getModel({ userId: 'u1' }, { modelId: 'm1' });
if (!result.ok) {
  console.log(result.error._tag);
}
```

### Scoped clients

```ts
const client = ServiceClient.create(MyContract, transport);
const scoped = ServiceClient.withContext(client, { userId: 'u1' });

const model = await scoped.getModel({ modelId: 'm1' });
```

## Service kind taxonomy

Every service is classified on a single lifecycle axis — `ephemeral`, `persistent`, or `workflow`. The kind is the primary dimension that determines how a service is deployed and operated (replica floor, scale-to-zero, scaling signal).

### The decision rule

> **Does the service hold state or work _between_ requests?**

- **No** → `ephemeral`. The service exists only while serving a request (request/response or a single long-lived stream) and may scale to zero when idle.
- **Yes** → `persistent`. The service is always-on with a replica floor and is never torn down.

Two rules sharpen the call:

- **Streaming does NOT force `persistent`.** A server-stream is one long-lived request, which is valid for `ephemeral`. You are not pushed to `persistent` purely because you stream.
- **Externalize state to stay `ephemeral`.** State held across requests must live in an external store (Valkey / NATS-KV / Postgres). Once it is externalized, the service holds nothing between requests and remains `ephemeral` — the more scalable pattern.

`workflow` is a third kind for durable orchestration workers (Temporal-style task processing). It is first-class for ergonomics but **inherits `persistent`'s operational profile**: it compiles to a persistent poller with a task queue, keeps a replica floor `>= 1`, and never scales to zero. A `workflow` declaration requires a `taskQueue`.

Transport is orthogonal to kind: an `ephemeral` service can still be `expose`d over HTTP. Choosing a transport never changes the kind.

### Default operational profile per kind

| Kind | Min replicas | Scale-to-zero | Default scaling signal |
|------|--------------|---------------|------------------------|
| `ephemeral` | 0 | yes | queue depth / consumer lag |
| `persistent` | ≥ 1 | no | CPU / custom |
| `workflow` | ≥ 1 | no | task-queue backlog |

These defaults are exported as `serviceKindProfiles`:

```ts
import { serviceKindProfiles, validateServiceKind } from '@insler/service';

serviceKindProfiles.ephemeral; // { minReplicas: 0, scaleToZero: true, scalingSignal: 'queue-depth' }

// validateServiceKind returns a list of issues (empty == valid):
validateServiceKind({ kind: 'persistent', scale: { min: 0 } });
// -> ["persistent services require a minimum replica floor >= 1, got scale.min=0"]

validateServiceKind({ kind: 'ephemeral', scale: { min: 2 } }); // -> []  (warm pool is fine)
```

A `workflow` declaration requires a `taskQueue` at the type level:

```ts
import type { KindDeclaration } from '@insler/service';

const w: KindDeclaration = { kind: 'workflow', taskQueue: 'onboarding' }; // ok
// const bad: KindDeclaration = { kind: 'workflow' }; // ✗ taskQueue is required
```

## Environment detection

The environment is detected automatically from `NODE_ENV` and related variables via `std-env`:

| Condition | Environment |
|---|---|
| `NODE_ENV=test` or test runner detected | `'test'` |
| `NODE_ENV=production` | `'production'` |
| `NODE_ENV=development` | `'development'` |
| Fallback | `'production'` |

Override with the `env` option on either `Service.create()` or `ServiceClient.create()`.

## Testing

The `@insler/service/test` entry point provides `ServiceTest` for in-process test pairs with handler validation:

```ts
import { ServiceTest } from '@insler/service/test';

const { client, stop } = await ServiceTest.pair(MyContract, {
  async getModel(ctx, { modelId }) {
    return { id: modelId, name: 'GPT-4', provider: 'openai', createdAt: new Date() };
  },
  // ...other handlers
});

const model = await client.getModel({ userId: 'u1' }, { modelId: 'm1' });

await stop();
```

`ServiceTest.pair()` validates that all contract methods have handlers before creating the pair. Use `ServiceTest.resultPair()` for result-mode error handling.

## License

MIT
