import type { HostHandler, HostRequest, HostResponse, HostStreamHandler } from './transport.js';

/**
 * Middleware that can intercept and transform host requests/responses.
 *
 * This is the unary-shaped signature. It is unchanged and remains the contract for unary
 * middleware authors; `HostMiddleware` is assignable to {@link HostStreamMiddleware}, so existing
 * middleware keeps working when the host wraps streaming handlers with the same chain.
 */
export type HostMiddleware = (
  request: HostRequest,
  next: (request: HostRequest) => Promise<HostResponse>
) => Promise<HostResponse>;

/**
 * The kind-discriminated `next` passed to streaming-aware host middleware. Its result follows the
 * request kind: a `serverStream` request produces a stream of responses, while every other kind
 * resolves to a single response — exactly the shape unary `next` already returns.
 */
export interface HostNext {
  (request: HostRequest & { readonly kind: 'serverStream' }): AsyncIterable<HostResponse>;
  (request: HostRequest): Promise<HostResponse>;
}

/**
 * Streaming-aware host middleware. Existing unary {@link HostMiddleware} is assignable to this
 * type, so unary middleware needs no edits; streaming-aware authors opt into the richer
 * {@link HostNext} and may return a stream for `serverStream` calls.
 */
export type HostStreamMiddleware = (
  request: HostRequest,
  next: HostNext
) => Promise<HostResponse> | AsyncIterable<HostResponse>;

/**
 * Compose an array of middleware into a single handler wrapper.
 * Middleware executes in array order (first middleware is outermost).
 *
 * The composition mechanics are identical for unary and streaming handlers — each layer only
 * threads the request to `next` and returns whatever `next` returns — so the same chain wraps a
 * unary handler or a `serverStream` handler.
 */
export function composeMiddleware(middleware: HostMiddleware[], handler: HostHandler): HostHandler;
export function composeMiddleware(
  middleware: HostStreamMiddleware[],
  handler: HostStreamHandler
): HostStreamHandler;
export function composeMiddleware(
  middleware: readonly (HostMiddleware | HostStreamMiddleware)[],
  handler: (request: HostRequest) => Promise<HostResponse> | AsyncIterable<HostResponse>
): (request: HostRequest) => Promise<HostResponse> | AsyncIterable<HostResponse> {
  let composed = handler;
  // Apply in reverse so first middleware is outermost
  for (let i = middleware.length - 1; i >= 0; i--) {
    const mw = middleware[i]! as HostStreamMiddleware;
    const next = composed as HostNext;
    composed = (request: HostRequest) => mw(request, next);
  }
  return composed;
}
