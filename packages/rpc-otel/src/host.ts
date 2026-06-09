import type { HostMiddleware } from '@insler/rpc-host';
import { SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';

import { parseTraceparent } from './traceparent.js';

const TRACER_NAME = 'rpc-host';
const TRACEPARENT_KEY = 'traceparent';

export interface HostTracingOptions {
  tracerName?: string;
}

export function tracingMiddleware(options?: HostTracingOptions): HostMiddleware {
  const tracerName = options?.tracerName ?? TRACER_NAME;

  return async (request, next) => {
    const tracer = trace.getTracer(tracerName);
    const spanName = `${request.service}/${request.method}`;

    let parentCtx = context.active();
    const traceparent = request.metadata?.[TRACEPARENT_KEY];
    if (traceparent) {
      const remote = parseTraceparent(traceparent);
      if (remote) {
        parentCtx = trace.setSpanContext(parentCtx, remote);
      }
    }

    const span = tracer.startSpan(
      spanName,
      {
        kind: SpanKind.SERVER,
        attributes: {
          'rpc.system': 'insler',
          'rpc.service': request.service,
          'rpc.method': request.method,
        },
      },
      parentCtx
    );

    try {
      const response = await context.with(trace.setSpan(parentCtx, span), () => next(request));

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
  };
}
