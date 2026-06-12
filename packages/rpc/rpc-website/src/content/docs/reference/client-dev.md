---
title: '@insler/rpc/client/dev'
description: Logging and timing middleware for development clients.
sidebar:
  order: 4
---

Development conveniences for the client side, shipped as ordinary client
middleware:

- `loggingMiddleware` — logs each call (method, input, outcome) as it flows
  through the client.
- `timingMiddleware` — measures and reports per-call latency.

```ts
import { Client } from '@insler/rpc/client';
import { loggingMiddleware, timingMiddleware } from '@insler/rpc/client/dev';

const accounts = Client.create(Accounts, clientTransport, {
  middleware: [loggingMiddleware(), timingMiddleware()],
});
```

Because these are plain middleware, they compose with anything else in the
chain and add nothing to production builds you don't ask for. The
environment-aware layer above this stack (`@insler/service`) wires them in
automatically for development clients — use that if you want dev defaults
without manual wiring.

Like all client middleware today, these fire on `unary` and `serverStream`
calls; `clientStream` and `duplex` bypass the middleware chain until
streaming middleware coverage lands.
