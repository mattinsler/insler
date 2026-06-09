# @insler/rpc-transport-memory

In-memory transport implementation for insler RPC with support for:

- Zero-configuration in-process communication
- Shared message bus connecting hosts and clients
- Instant host+client pairs for testing and development
- Monolith mode with multiple services in one process

## Install

```sh
bun add @insler/rpc-transport-memory
```

## Quick start

The `createMemoryTransport()` convenience function creates a connected client+host transport pair backed by a shared in-memory bus:

```ts
import { createMemoryTransport } from '@insler/rpc-transport-memory';
import { Client } from '@insler/rpc-client';
import { Host } from '@insler/rpc-host';

const transport = createMemoryTransport();

const host = await Host.create(MyContract, handlers, transport.host);
const client = Client.create(MyContract, transport.client);

const result = await client.someMethod(input);

await host.stop();
```

## MemoryBus

The `MemoryBus` is the core routing layer. Handlers register by `service.method` key, and clients invoke through the same key.

```ts
import { MemoryBus } from '@insler/rpc-transport-memory';

const bus = new MemoryBus();
```

Handlers are registered per service+method and return an unregister function:

```ts
const unregister = bus.register('my-service', 'getModel', async (request) => {
  return { output: { id: 'm1', name: 'GPT-4' } };
});

const response = await bus.invoke('my-service', 'getModel', request);

unregister();
```

Duplicate registrations for the same key throw an error. Invoking an unregistered key returns a `__not_found__` error response.

## Individual transports

For more control, create the bus and transports separately:

```ts
import { MemoryBus, MemoryClientTransport, MemoryHostTransport } from '@insler/rpc-transport-memory';

const bus = new MemoryBus();
const clientTransport = new MemoryClientTransport(bus);
const hostTransport = new MemoryHostTransport(bus);
```

### Multiple services on one bus

Run multiple services in a single process by sharing a bus:

```ts
const bus = new MemoryBus();
const hostTransport = new MemoryHostTransport(bus);
const clientTransport = new MemoryClientTransport(bus);

const usersHost = await Host.create(UsersContract, usersHandlers, hostTransport);
const ordersHost = await Host.create(OrdersContract, ordersHandlers, hostTransport);

const usersClient = Client.create(UsersContract, clientTransport);
const ordersClient = Client.create(OrdersContract, clientTransport);
```

## License

MIT
