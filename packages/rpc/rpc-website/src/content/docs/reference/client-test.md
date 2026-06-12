---
title: '@insler/rpc/client/test'
description: TestTransport — unit-test client logic in isolation, without a host.
sidebar:
  order: 5
---

A `ClientTransport` fake for unit-testing client-side logic in isolation —
no host, no bus, no network.

```ts
import { Client } from '@insler/rpc/client';
import { TestTransport } from '@insler/rpc/client/test';

const transport = new TestTransport();
transport.on('getBalance').returns({ balance: 42 });

const accounts = Client.create(Accounts, transport);
await accounts.getBalance({ accountId: 'a_1' }); // { balance: 42 }

transport.calls; // every invocation the client made, for assertions
```

- `.on(method).returns(value)` — stub a successful response.
- `.on(method).throws(error)` — stub a typed failure.
- `.calls` — the recorded invocations, for asserting what the client sent.

## When to use it

This is the cheapest, most-isolated seam: use it for client logic — error
modes, middleware behavior, scoped-client context. When you want a *real*
contract + host + client pair in one process, step up to `TestHost.pair` from
[`@insler/rpc/host/test`](/reference/host-test/), the default integration
seam.
