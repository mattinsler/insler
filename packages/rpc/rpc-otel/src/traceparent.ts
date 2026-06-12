import type { SpanContext } from '@opentelemetry/api';

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function formatTraceparent(sc: SpanContext): string {
  return `00-${sc.traceId}-${sc.spanId}-${sc.traceFlags.toString(16).padStart(2, '0')}`;
}

export function parseTraceparent(traceparent: string): SpanContext | null {
  const match = traceparent.match(TRACEPARENT_RE);
  if (!match) return null;
  return {
    traceId: match[1]!,
    spanId: match[2]!,
    traceFlags: parseInt(match[3]!, 16),
    isRemote: true,
  };
}
