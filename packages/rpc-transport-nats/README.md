# @insler/rpc-transport-nats

NATS transport implementation for insler RPC with support for:

- Request/reply communication over NATS subjects
- Queue group subscriptions for load balancing
- Configurable subject prefix and request timeout
- Pluggable serialization via the `@insler/serde` interface
- Automatic error handling for timeouts, connection failures, and decode errors
- ADR-32 discovery: hosted services answer `$SRV.PING` / `$SRV.INFO` / `$SRV.STATS` so the standard `nats micro` CLI can find, introspect, and monitor them

## Install

```sh
bun add @insler/rpc-transport-nats
```

## Quick start

The `createNatsTransport()` convenience function creates a connected client+host transport pair backed by a shared NATS connection:

```ts
import { connect } from 'nats';
import { createNatsTransport } from '@insler/rpc-transport-nats';
import { Client } from '@insler/rpc-client';
import { Host } from '@insler/rpc-host';

const nc = await connect({ servers: 'nats://localhost:4222' });
const transport = createNatsTransport({ connection: nc });

const host = await Host.create(MyContract, handlers, transport.host);
const client = Client.create(MyContract, transport.client);

const result = await client.someMethod(input);

await host.stop();
await nc.close();
```

## Options

```ts
const transport = createNatsTransport({
  connection: nc,
  serde: myCustomSerde,     // default: jsonBytesSerde (SuperJSON over Uint8Array)
  timeout: 10000,           // client request timeout in ms (default: 5000)
  subjectPrefix: 'myapp',   // NATS subject prefix (default: 'rpc')
  queue: 'workers',         // queue group for load-balanced host subscriptions
  idleTimeout: 30000,       // per-call streaming idle (stall) window in ms (default: 30000; 0 disables)
  deadline: undefined,      // optional overall streaming deadline in ms (default: OFF)
});
```

### Subject format

Requests are published to NATS subjects in the format:

```
{subjectPrefix}.{service}.{method}
```

For example, with the default prefix, calling `getModel` on a `model-registry` service sends to `rpc.model-registry.getModel`.

### Queue groups

Host subscriptions join a NATS queue group (default `q`, per ADR-0001), so the method subject load-balances across host instances — only one host in the group receives each request (and each streaming open). Pass a different `queue` to change the group.

## Individual transports

For more control, create the transports separately:

```ts
import { NatsClientTransport, NatsHostTransport } from '@insler/rpc-transport-nats';

const clientTransport = new NatsClientTransport({
  connection: nc,
  timeout: 10000,
});

const hostTransport = new NatsHostTransport({
  connection: nc,
  queue: 'workers',
});
```

## Error responses

The NATS transport surfaces transport-level errors as typed error responses rather than throwing:

| Error tag | Condition |
|---|---|
| `__timeout__` | Unary request exceeded the configured `timeout`, or a streaming call exceeded its idle window / overall deadline |
| `__transport__` | NATS connection closed, publish failed, or a frame-`seq` gap was detected mid-stream |
| `__serde__` | Failed to encode/decode a request, response, or stream frame |
| `__validation__` | A streamed input failed contract validation |
| `__internal__` / `__unknown__` | Uncaught host-handler throw — internals never leak across the wire |

## Discovery (NATS ADR-32)

Every hosted service is also presented to NATS as a standard
[ADR-32](https://github.com/nats-io/nats-architecture-and-design/blob/main/adr/ADR-32.md)
micro service, so the off-the-shelf `nats micro` CLI and any ADR-32 client can
discover it with zero bespoke tooling. On `register()`, each host instance:

- mints a unique service `id` (instance identity, stable for that registration);
- validates the contract service name against the ADR-32 charset (`A–Z a–z 0–9 - _`)
  and **rejects out-of-charset names loudly** — a name that cannot be advertised
  fails fast rather than silently skipping discovery;
- subscribes to the control subjects `$SRV.PING` / `$SRV.INFO` / `$SRV.STATS` (and
  their `.<name>` and `.<name>.<id>` forms) **without a queue group**, so every
  instance answers and discovery enumerates the whole fleet.

A `$SRV.PING` request returns the verbatim `io.nats.micro.v1.ping_response`
(`type`, `name`, `id`, `version`, `metadata`). A `$SRV.INFO` request returns the
verbatim `io.nats.micro.v1.info_response` — the same standard fields plus
`description` and `endpoints`, one `EndpointInfo` (`name`, `subject`,
`queue_group`, `metadata`) per contract method. A `$SRV.STATS` request returns the
verbatim `io.nats.micro.v1.stats_response` — the standard fields plus `started`
(ISO-8601 UTC) and per-endpoint stats (`num_requests`, `num_errors`, `last_error?`,
`processing_time`, `average_processing_time`; times in nanoseconds). Any reserved
`__*__` tag or declared contract error counts as an error; for streaming endpoints
the counted unit is the **call** (not the frame), with `processing_time` measured
open→close. These control-plane responses are always **plain JSON**, independent of
the injected application serde, so standard tooling parses them.

Each endpoint's `metadata` advertises the framework descriptors so ADR-32 tooling
can introspect the contract surface:

- `dev.insler.rpc.kind` — `unary | serverStream | clientStream | duplex` (read
  straight from the method registration);
- `dev.insler.rpc.contract_version` — the contract version;
- `dev.insler.rpc.input` / `dev.insler.rpc.output` — **optional** schema
  fingerprints. These are a pure pass-through: the transport publishes whatever
  fingerprint it is given (keyed by method name) and omits the key otherwise. The
  fingerprint *format* and compatibility semantics are a `@insler/rpc-contract` concern,
  not this transport's.

```sh
# discover / ping @insler services with the standard CLI
nats micro ls
nats micro ping
```

The `version`, `description`, service-level `metadata`, and per-method
`fingerprints` advertised on discovery are set on the host transport:

```ts
const transport = createNatsTransport({
  connection: nc,
  version: '1.2.3',            // ADR-32 service version (default: '0.0.0')
  description: 'Thing service', // INFO description (default: '')
  metadata: { team: 'core' },  // service-level metadata (default: {})
  fingerprints: {              // optional per-method schema fingerprints (default: none)
    getThing: { input: 'sha256:…', output: 'sha256:…' },
  },
});
```

> The application/RPC subjects (`{subjectPrefix}.{service}.{method}`) carry **no**
> `$SRV` prefix — the control plane and data plane stay cleanly separated.
>
> All three verbs (`PING` / `INFO` / `STATS`) are wired over the shared `subscribeVerb`
> seam, so `nats micro ls`, `nats micro ping`, `nats micro info <name>`, and
> `nats micro stats <name>` all work against `@insler` services with zero bespoke tooling.

## Streaming (RPC plane)

`serverStream`, `clientStream`, and `duplex` work end-to-end over core NATS — no JetStream
required (ADR-0001 §2.2–2.4).
A streaming call is opened with **one queue-grouped request** on the method subject
(`{subjectPrefix}.{service}.{method}`) carrying an `OpenRequest`:

```
OpenRequest { input?, metadata?, up, down, credit }
```

- `input` — the single request (serverStream);
- `metadata` — context propagation, exactly as unary;
- `up` / `down` — client-allocated, opaque, **per-call** inboxes (`up` = client→host,
  `down` = host→client), generated via the NATS client's standard new-inbox generation;
- `credit` — the initial `down` window the client grants the host.

The selected host instance subscribes `up` **without a queue group** (pinning the call to
that instance, so horizontal scaling still works), runs the `serverStream` handler, and
publishes output `DataFrame`s followed by exactly one terminal `EndFrame` on `down`. The
client yields each decoded output until the `EndFrame`, then tears down both inboxes — no
per-call subscriptions leak. Frames ride the **same injected serde** as unary, so a binary
serde (CBOR/msgpack/avro) streams without special-casing.

```ts
for await (const event of client.watch({ topic: 'orders' })) {
  // each `event` is a decoded output, in order, until the stream ends
}
```

`clientStream` meters the **other** direction. The client streams each input as a `DataFrame`
on `up`, then half-closes `up` with exactly one `EndFrame`; the host runs the `clientStream`
handler over the inbound input `AsyncIterable`, then publishes its single output `DataFrame`
followed by one `EndFrame` on `down` (the `down` `EndFrame` is call completion). Back-pressure
flows on `up`: the **host** grants the client credit (its first `CreditFrame` on `down`, then
one per input it consumes), so a slow host consumer bounds the client's in-flight input to the
credit window. Errors and transport faults map exactly as serverStream (declared error →
typed; undeclared throw → `__unknown__`; bad input → `__validation__`; decode → `__serde__`;
early close / seq gap → `__transport__`).

`duplex` runs **both** directions independently and concurrently — it is the union of the two
halves above. The client streams inputs on `up` (paced by the **host-granted** `up` window),
while the host streams outputs on `down` (paced by the **client-granted** `down` window); the
two windows are independent, so back-pressure on one direction never throttles the other. Each
direction half-closes with its **own** `EndFrame`, and the call completes only when **both**
have. An `ErrorFrame`/`CancelFrame` is terminal for the whole call and tears down both
directions; already-yielded outputs stay delivered. The same `__*__` tag vocabulary applies.

```ts
async function* inputs() {
  yield { msg: 'hello' };
  yield { msg: 'world' };
}
for await (const reply of client.echo(inputs())) {
  // outputs arrive as the host produces them — concurrently with sending inputs
}
```

```ts
const total = await client.sum(values()); // one aggregated response from a stream of inputs
```

### Frame envelope

Every message on `up`/`down` is a serde-encoded `Frame` (short field names — they ride every
frame). The full vocabulary is exported (`encodeFrame` / `decodeFrame` / `Frame` / `SeqCounter`,
plus `allocateCallInboxes` / `subscribeFrames` for the per-call subscription lifecycle):

```
DataFrame   { t: 'd', seq, data }   // data = method's serde-encoded output
EndFrame    { t: 'e', seq }         // half-close: this direction is done
ErrorFrame  { t: 'x', error }       // terminal for the whole call
CreditFrame { t: 'c', n }           // grant peer n more DataFrames
CancelFrame { t: 'a', reason? }     // abort the whole call, both directions
```

`seq` is a per-direction monotonic counter from 0 (loss/gap **detection**, not reassembly).

### Liveness, cancellation & deadlines

Core NATS cannot tell a parked receiver that its peer has silently died — an inbox simply stops
delivering. Two per-call timers (ADR-0001 §2.7), applied on **both** the client (`down`) and host
(`up`) sides, guard against that:

- **Idle (stall) timeout** — if **no frame (data _or_ control)** arrives within `idleTimeout`
  (default **30 000 ms**; `0`/negative disables), the waiting side fails the call with
  `__timeout__` and unsubscribes. The window **resets on every inbound frame**, so a steady — even
  slow — peer never trips it; only genuine silence does. This is the primary guard against a
  half-dead call hanging forever.
- **Overall deadline** — an **optional** hard ceiling (`deadline`, in ms). **Default OFF** for
  streams, since a streaming call may legitimately be long-lived; a deployment opts in to cap one.
  On expiry the call is cancelled with `__timeout__`.

**Cancellation.** Either side may abort the whole call with a `CancelFrame { reason? }`; the peer
**stops sending** and tears down both directions. The client **initiates** a cancel when the
consumer abandons the iterator early (a `break` / `return()` out of the `for await`) or a liveness
timer fires — so abandoned host work stops promptly rather than running to completion. The host
likewise stops pulling its handler the moment it observes a client `CancelFrame`/`ErrorFrame` on
`up` (or a liveness expiry).

On any terminal frame, timeout, or host `unregister()`, **both** sides unsubscribe `up`/`down`;
the host's per-call `up` subscription is tied to the **call** lifetime, never the service, so
in-flight calls are torn down on `unregister()` and no per-call inbox leaks as services churn.

> **Scope today:** `serverStream`, `clientStream`, and `duplex` are complete — Data/End frames,
> credit-based back-pressure (real pausing on each metered direction, **independent** windows per
> direction for `duplex`), mid-stream error/fault mapping (`ErrorFrame`), and per-call liveness +
> cancellation (idle timeout, optional deadline, `CancelFrame` from either side). For `duplex`, both
> directions stream concurrently and each half-closes with its own `EndFrame`; the call completes
> only when both have. No method returns "not supported".

## Serialization

By default, the transport uses `jsonBytesSerde` from `@insler/serde`, which serializes values as SuperJSON-encoded `Uint8Array`. Pass a custom `Serde<Uint8Array>` to use a different format:

```ts
import type { Serde } from '@insler/serde';
import { encode, decode } from '@msgpack/msgpack';

const msgpackSerde: Serde<Uint8Array> = {
  encode: (value) => encode(value),
  decode: (wire) => decode(wire),
};

const transport = createNatsTransport({
  connection: nc,
  serde: msgpackSerde,
});
```

## License

MIT
