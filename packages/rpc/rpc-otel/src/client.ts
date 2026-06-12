import type { ClientMiddleware } from '@insler/rpc/client';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

import { formatTraceparent } from './traceparent.js';

const TRACER_NAME = 'rpc-client';
const TRACEPARENT_KEY = 'traceparent';

export interface ClientTracingOptions {
  tracerName?: string;
}

export function tracingMiddleware(options?: ClientTracingOptions): ClientMiddleware {
  const tracerName = options?.tracerName ?? TRACER_NAME;

  return (request, next) => {
    const tracer = trace.getTracer(tracerName);
    const spanName = `${request.service}/${request.method}`;

    return tracer.startActiveSpan(
      spanName,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'rpc.system': 'insler',
          'rpc.service': request.service,
          'rpc.method': request.method,
        },
      },
      async (span) => {
        try {
          const traceparent = formatTraceparent(span.spanContext());
          const metadata = { ...request.metadata, [TRACEPARENT_KEY]: traceparent };
          const response = await next({ ...request, metadata });

          if (response.error) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: response.error._tag });
            span.setAttribute('rpc.error_tag', response.error._tag);
          }

          span.end();
          return response;
        } catch (error) {
          if (error instanceof Error) span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
          span.end();
          throw error;
        }
      }
    );
  };
}
