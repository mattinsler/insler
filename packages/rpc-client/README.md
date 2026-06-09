# @insler/rpc-client

Type-safe RPC client for insler service contracts with support for:

- Fully typed method calls derived from contract definitions
- Throw-mode (default) and result-mode error handling
- Scoped clients with pre-applied context
- Composable middleware pipeline
- Pluggable transport interface

## Install

```sh
bun add @insler/rpc-client
```

## Creating a client

Create a client from a contract and a transport. The client's methods are fully typed based on the contract definition.

```ts
import { Client } from '@insler/rpc-client';

const client = Client.create(MyContract, transport);

const model = await client.getModel({ userId: 'u1' }, { modelId: 'm1' });
```

## Error handling

### Throw mode (default)

By default, contract errors are thrown as `ContractError` instances:

```ts
import { Client, ContractError } from '@insler/rpc-client';

const client = Client.create(MyContract, transport);

try {
  await client.getModel({ userId: 'u1' }, { modelId: 'm1' });
} catch (err) {
  if (err instanceof ContractError) {
    console.log(err._tag);    // 'NotFound'
    console.log(err.payload); // { modelId: 'm1' }
  }
}
```

### Result mode

With `errors: 'result'`, methods return a discriminated union instead of throwing:

```ts
const client = Client.create(MyContract, transport, { errors: 'result' });

const result = await client.getModel({ userId: 'u1' }, { modelId: 'm1' });

if (result.ok) {
  console.log(result.value); // the model
} else {
  console.log(result.error._tag);    // 'NotFound'
  console.log(result.error.payload); // { modelId: 'm1' }
}
```

## Scoped clients

Use `Client.withContext()` to create a scoped client with context pre-applied to all calls:

```ts
const client = Client.create(MyContract, transport);
const scoped = Client.withContext(client, { userId: 'u1' });

// No need to pass context — it's already applied
const model = await scoped.getModel({ modelId: 'm1' });
```

Scoped clients work with both throw-mode and result-mode clients.

## Middleware

Middleware wraps the client call pipeline. Each middleware can inspect or modify the request and response:

```ts
import type { ClientMiddleware } from '@insler/rpc-client';

const authMiddleware: ClientMiddleware = async (request, next) => {
  const authedRequest = {
    ...request,
    metadata: { ...request.metadata, token: 'my-token' },
  };
  return next(authedRequest);
};

const client = Client.create(MyContract, transport, {
  middleware: [authMiddleware],
});
```

Middleware executes in array order — the first middleware in the array is the outermost wrapper.

### Built-in middleware

The `@insler/rpc-client/dev` entry point provides development middleware:

```ts
import { loggingMiddleware, timingMiddleware } from '@insler/rpc-client/dev';

const client = Client.create(MyContract, transport, {
  middleware: [
    loggingMiddleware(),
    timingMiddleware({
      onCall: ({ service, method, durationMs, ok }) => {
        metrics.record(service, method, durationMs, ok);
      },
    }),
  ],
});
```

## Transport interface

Transport implementations must satisfy the `ClientTransport` interface:

```ts
import type { ClientTransport, ClientRequest, ClientResponse } from '@insler/rpc-client';

class MyTransport implements ClientTransport {
  async invoke(request: ClientRequest): Promise<ClientResponse> {
    // Send request over your transport layer
  }
}
```

## Testing

The `@insler/rpc-client/test` entry point provides a `TestTransport` for unit testing:

```ts
import { Client } from '@insler/rpc-client';
import { TestTransport } from '@insler/rpc-client/test';

const transport = new TestTransport();
transport.on('getModel').returns({ id: 'm1', name: 'GPT-4' });

const client = Client.create(MyContract, transport);
const model = await client.getModel({ modelId: 'm1' });

// Inspect recorded calls
transport.calls; // [{ service: '...', method: 'getModel', ... }]
```

Configure error responses:

```ts
transport.on('getModel').throws('NotFound', { modelId: 'm1' });
```

## License

MIT
