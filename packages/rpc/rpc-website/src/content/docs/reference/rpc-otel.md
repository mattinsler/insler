---
title: '@insler/rpc-otel'
description: OpenTelemetry tracing as client and host middleware, plus W3C traceparent helpers.
sidebar:
  order: 11
---

The OpenTelemetry adapter package — distributed tracing for the RPC stack,
delivered as ordinary middleware. It exists to bind `@opentelemetry/api`, so
it stays out of the umbrella per the core/adapter rule; the stack works
without it.

```sh
bun add @insler/rpc-otel
```

```ts
import { Client } from '@insler/rpc/client';
import { Host } from '@insler/rpc/host';
import { clientTracingMiddleware, hostTracingMiddleware } from '@insler/rpc-otel';

const accounts = Client.create(Accounts, clientTransport, {
  middleware: [clientTracingMiddleware()],
});

const host = await Host.create(Accounts, handlers, hostTransport, {
  middleware: [hostTracingMiddleware()],
});
```

Spans propagate across the call via request metadata using the W3C
`traceparent` format; `formatTraceparent` / `parseTraceparent` are exported
for anything else that needs to read or write it.

## What it does not own

OTel SDK setup — providers, exporters, sampling — belongs to your
application; this package emits spans against the global `@opentelemetry/api`
only. It also doesn't reimplement context propagation: trace headers ride the
same request metadata the `/context` propagator uses.

Middleware coverage follows the client/host layers it plugs into: spans fire
on `unary` and `serverStream` calls today; `clientStream` and `duplex`
bypass middleware until streaming middleware coverage lands.
