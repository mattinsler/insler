---
title: '@insler/rpc/host/dev'
description: Logging middleware and handler validation for development hosts.
sidebar:
  order: 7
---

Development conveniences for the server side:

- `loggingMiddleware` — host middleware that logs each request (method,
  context, outcome) as it is handled.
- `validateHandlers` — checks a handler map against a contract ahead of
  serving, so a missing or misshapen handler is reported as a development
  diagnostic rather than discovered at create time in a running process.

```ts
import { Host } from '@insler/rpc/host';
import { loggingMiddleware, validateHandlers } from '@insler/rpc/host/dev';

validateHandlers(Accounts, handlers);

const host = await Host.create(Accounts, handlers, hostTransport, {
  middleware: [loggingMiddleware()],
});
```

As with the client-side dev helpers, the environment-aware `@insler/service`
layer wires these in automatically for development hosts — reach for that
when you want dev defaults without manual wiring.

Host middleware coverage is partial today: the chain wraps `unary` and
`serverStream` handlers; `clientStream` and `duplex` handlers run without it
until streaming middleware coverage lands.
