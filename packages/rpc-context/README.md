# @insler/rpc-context

Context propagation for `@insler` RPC. Moves per-request context (identity, locale, feature flags, …) into and out of request metadata via a serde-backed `Propagator`, so application context rides alongside ambient metadata like `traceparent`.

## Install

```sh
bun add @insler/rpc-context
```

## Propagator

A `Propagator` injects context into a string carrier and extracts requested keys back out:

```ts
interface Propagator {
  inject(context: Record<string, unknown>, carrier: Record<string, string>): void;
  extract(keys: readonly string[], carrier: Record<string, string>): Record<string, unknown>;
}
```

The carrier is the request metadata map. `inject` writes one carrier entry per context key; `extract` reads only the keys you ask for, leaving everything else (e.g. `traceparent`) untouched.

## createPropagator

`createPropagator` builds a `Propagator` from any `Serde<string>` — each context value is encoded/decoded independently, so rich types survive when the serde supports them.

```ts
import { createPropagator } from '@insler/rpc-context';
import { jsonSerde } from '@insler/serde-json';

const propagator = createPropagator(jsonSerde);

// Client side: inject context into outgoing metadata
const carrier: Record<string, string> = { traceparent: '00-abc-def-01' };
propagator.inject({ identity: { userId: 'u1', orgId: 'o1' }, locale: 'en-US' }, carrier);
// carrier now also has `identity` and `locale`; `traceparent` is preserved

// Host side: extract the keys you care about from incoming metadata
const ctx = propagator.extract(['identity', 'locale'], carrier);
// { identity: { userId: 'u1', orgId: 'o1' }, locale: 'en-US' }
```

Keys absent from the carrier are skipped, so `extract` only returns context that was actually sent.

## Custom propagators

`Propagator` is a plain interface — implement it directly when you need behavior `createPropagator` doesn't cover, such as namespacing context keys under a prefix:

```ts
import type { Propagator } from '@insler/rpc-context';

const prefixed: Propagator = {
  inject(context, carrier) {
    for (const [key, value] of Object.entries(context)) {
      carrier[`ctx.${key}`] = JSON.stringify(value);
    }
  },
  extract(keys, carrier) {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const raw = carrier[`ctx.${key}`];
      if (raw !== undefined) out[key] = JSON.parse(raw);
    }
    return out;
  },
};
```

## License

MIT
