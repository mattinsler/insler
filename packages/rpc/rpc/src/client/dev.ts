import type { ClientMiddleware } from './middleware.js';

/**
 * A middleware that logs all client calls before and after execution.
 */
export function loggingMiddleware(options?: {
  logger?: (message: string) => void;
  prefix?: string;
}): ClientMiddleware {
  const log = options?.logger ?? console.log;
  const prefix = options?.prefix ?? '[rpc-client]';

  return async (request, next) => {
    const label = `${request.service}.${request.method}`;
    const inputSummary = request.input !== undefined ? JSON.stringify(request.input) : '(void)';

    log(`${prefix} → ${label} (${inputSummary})`);

    const start = performance.now();
    const response = await next(request);
    const durationMs = Math.round(performance.now() - start);

    const status = response.error ? `error: ${response.error._tag}` : 'ok';
    log(`${prefix} ← ${label} (${durationMs}ms) (${status})`);

    return response;
  };
}

/**
 * A middleware that tracks call timing and optionally reports it via a callback.
 */
export function timingMiddleware(options?: {
  onCall?: (info: { service: string; method: string; durationMs: number; ok: boolean }) => void;
}): ClientMiddleware {
  return async (request, next) => {
    const start = performance.now();
    const response = await next(request);
    const durationMs = Math.round(performance.now() - start);

    options?.onCall?.({
      service: request.service,
      method: request.method,
      durationMs,
      ok: !response.error,
    });

    return response;
  };
}
