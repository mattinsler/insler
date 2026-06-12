# @insler/rpc-otel

[OpenTelemetry](https://opentelemetry.io/) tracing for `@insler` RPC, delivered as client and host middleware. The client middleware opens a `CLIENT` span and injects a W3C `traceparent` into request metadata; the host middleware extracts it and opens a linked `SERVER` span — so traces stitch together across the call boundary.

## Install

```sh
bun add @insler/rpc-otel @opentelemetry/api
```

`@opentelemetry/api` is a peer dependency. You also need a configured tracer provider (e.g. the OpenTelemetry SDK) for spans to be exported.

## Client middleware

`clientTracingMiddleware` wraps each call in a `CLIENT` span named `<service>/<method>`, sets `rpc.*` attributes, and propagates the active span's `traceparent` through request metadata. Errored responses are marked with `SpanStatusCode.ERROR` and an `rpc.error_tag` attribute.

```ts
import { clientTracingMiddleware } from '@insler/rpc-otel';

const client = Client.create(MyContract, transport, {
  middleware: [clientTracingMiddleware()],
});
```

Override the tracer name if you want spans grouped under your own instrumentation scope:

```ts
clientTracingMiddleware({ tracerName: 'my-service-client' });
```

## Host middleware

`hostTracingMiddleware` reads the incoming `traceparent`, restores it as the parent context, and opens a `SERVER` span named `<service>/<method>` for the handler. As on the client, errored responses set the span status and `rpc.error_tag`.

```ts
import { hostTracingMiddleware } from '@insler/rpc-otel';

const host = await Host.create(MyContract, handlers, transport, {
  middleware: [hostTracingMiddleware()],
});
```

```ts
hostTracingMiddleware({ tracerName: 'my-service-host' });
```

## traceparent helpers

The W3C [`traceparent`](https://www.w3.org/TR/trace-context/#traceparent-header) format/parse helpers are exported for direct use:

```ts
import { formatTraceparent, parseTraceparent } from '@insler/rpc-otel';

const header = formatTraceparent(span.spanContext());
// '00-<32 hex traceId>-<16 hex spanId>-01'

const spanContext = parseTraceparent(header);
// SpanContext | null (null on malformed input)
```

## License

MIT
