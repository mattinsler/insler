---
title: '@insler/rpc/host/test'
description: TestHost.pair — an in-process host + client pair over the memory transport, the default integration seam.
sidebar:
  order: 8
---

The **default integration seam** for services built on this stack:
`TestHost.pair(contract, handlers)` gives you a real contract, real host
validation, and a real typed client over an in-memory bus — no external
dependencies, no mocks of your own code.

```ts
import { TestHost } from '@insler/rpc/host/test';

const { client, host } = await TestHost.pair(Accounts, handlers);

await client.getBalance({ accountId: 'a_1' }); // validated end to end
await host.stop();
```

- `TestHost.pair(contract, handlers)` — a throw-mode client + host pair.
- `TestHost.resultPair(contract, handlers)` — the result-mode variant, for
  asserting typed errors as `{ ok: false, error }` values.

## When to use it

Write integration tests here unless the test is specifically about wire
behavior. Everything a consumer observes — validation failures, typed
errors, context extraction, streaming — behaves exactly as it does over a
real transport, because it *is* the real client and host wired over
`@insler/rpc/transport-memory`. For client-only logic use the cheaper
[`TestTransport`](/reference/client-test/); for wire-format, serde, or
queue-group behavior test against the
[NATS adapter](/reference/rpc-transport-nats/) and a real server.
