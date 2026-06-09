import type { ContractDef } from '@insler/rpc-contract';

import type { HostMiddleware } from './middleware.js';

/**
 * Options for the logging middleware.
 */
export interface LoggingMiddlewareOptions {
  /** Custom logger function. Defaults to `console.log`. */
  logger?: (message: string) => void;
  /** Prefix for log messages. Defaults to `'[rpc-host]'`. */
  prefix?: string;
}

/**
 * A `HostMiddleware` that logs all incoming handler calls with timing.
 *
 * Logs before the handler: `[rpc-host] <- service.method`
 * Logs after the handler:  `[rpc-host] -> service.method (Xms) (ok | error: tag)`
 */
export function loggingMiddleware(options?: LoggingMiddlewareOptions): HostMiddleware {
  const log = options?.logger ?? console.log;
  const prefix = options?.prefix ?? '[rpc-host]';

  return async (request, next) => {
    const label = `${request.service}.${request.method}`;
    log(`${prefix} <- ${label}`);

    const start = performance.now();
    const response = await next(request);
    const duration = Math.round(performance.now() - start);

    const status = response.error ? `error: ${response.error._tag}` : 'ok';
    log(`${prefix} -> ${label} (${duration}ms) (${status})`);

    return response;
  };
}

/**
 * Validate that all contract methods have corresponding handlers.
 * Returns an array of missing method names, or an empty array if complete.
 *
 * Useful for dev/CI checks to catch missing handler implementations early.
 */
export function validateHandlers(
  contract: ContractDef,
  handlers: Record<string, unknown>
): string[] {
  const missing: string[] = [];

  for (const methodDef of contract.methodList) {
    if (typeof handlers[methodDef.name] !== 'function') {
      missing.push(methodDef.name);
    }
  }

  return missing;
}
