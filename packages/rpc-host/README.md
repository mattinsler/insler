# @insler/rpc-host

Type-safe RPC host for insler service contracts with support for:

- Automatic input/output validation via Zod
- Context extraction from request metadata
- Contract error propagation with unknown-error safety
- Composable middleware pipeline
- Pluggable transport interface

## Install

```sh
bun add @insler/rpc-host
```

## Creating a host

Create a host from a contract, handler implementations, and a transport. The host validates inputs and outputs, extracts context, and catches exceptions.

```ts
import { Host } from '@insler/rpc-host';

const host = await Host.create(MyContract, {
  async getModel({ userId }, { modelId }) {
    const model = await db.findModel(modelId);
    if (!model) throw { _tag: 'NotFound', payload: { modelId } };
    return model;
  },
  async listModels({ userId }, input) {
    return { data: await db.listModels(input?.provider) };
  },
  async healthCheck() {
    return { ok: true };
  },
}, transport);

// Later, stop serving
await host.stop();
```

## Input/output validation

The host automatically validates inputs and outputs against the contract's Zod schemas. If validation fails, the host returns a `__validation__` error without calling the handler.

## Context extraction

Context values are extracted from the request's `metadata` field based on the contract's context schema. Contract-level context applies to all methods unless a method overrides it with its own `context` definition.

## Error handling

Handlers can throw contract errors by throwing objects with a `_tag` property:

```ts
async getModel(ctx, { modelId }) {
  throw { _tag: 'NotFound', payload: { modelId } };
}
```

Unknown errors (without `_tag`) are caught and returned as `__unknown__` errors. Internal details are not leaked to the client.

## Middleware

Host middleware wraps the handler pipeline, similar to client middleware:

```ts
import type { HostMiddleware } from '@insler/rpc-host';

const authMiddleware: HostMiddleware = async (request, next) => {
  if (!request.metadata?.token) {
    return { error: { _tag: 'Unauthorized', message: 'Missing token' } };
  }
  return next(request);
};

const host = await Host.create(MyContract, handlers, transport, {
  middleware: [authMiddleware],
});
```

### Built-in middleware

The `@insler/rpc-host/dev` entry point provides development utilities:

```ts
import { loggingMiddleware, validateHandlers } from '@insler/rpc-host/dev';

// Log all incoming calls with timing
const host = await Host.create(MyContract, handlers, transport, {
  middleware: [loggingMiddleware()],
});

// Validate that all contract methods have handlers
const missing = validateHandlers(MyContract, handlers);
if (missing.length > 0) {
  throw new Error(`Missing handlers: ${missing.join(', ')}`);
}
```

## Transport interface

Transport implementations must satisfy the `HostTransport` interface:

```ts
import type { HostTransport, HostRegistration, HostUnregister } from '@insler/rpc-host';

class MyTransport implements HostTransport {
  async register(registration: HostRegistration): Promise<HostUnregister> {
    // Subscribe to incoming requests for each method
    // Return an unregister function
  }
}
```

## Testing

The `@insler/rpc-host/test` entry point provides `TestHost` for creating in-process host+client pairs:

```ts
import { TestHost } from '@insler/rpc-host/test';

const { client, stop } = await TestHost.pair(MyContract, {
  async getModel(ctx, { modelId }) {
    return { id: modelId, name: 'GPT-4', provider: 'openai', createdAt: new Date() };
  },
  // ...other handlers
});

const model = await client.getModel({ userId: 'u1' }, { modelId: 'm1' });

await stop();
```

For result-mode error handling in tests:

```ts
const { client, stop } = await TestHost.resultPair(MyContract, handlers);
const result = await client.getModel({ userId: 'u1' }, { modelId: 'm1' });
if (!result.ok) {
  console.log(result.error._tag);
}
```

## License

MIT
