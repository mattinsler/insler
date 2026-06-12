import type { ClientRequest, ClientResponse } from './transport.js';

/**
 * A middleware function that wraps the client call pipeline.
 * Each middleware can inspect/modify the request, call `next()`, and inspect/modify the response.
 *
 * This is the unary-shaped signature. It is unchanged and remains the contract for unary
 * middleware authors; `ClientMiddleware` is assignable to {@link ClientStreamMiddleware}, so
 * existing middleware keeps working when the client routes streaming calls through the chain.
 */
export type ClientMiddleware = (
  request: ClientRequest,
  next: (request: ClientRequest) => Promise<ClientResponse>
) => Promise<ClientResponse>;

/**
 * The kind-discriminated `next` passed to streaming-aware client middleware. Its result follows
 * the request kind: a `serverStream` request produces a stream of responses, while every other
 * kind resolves to a single response — exactly the shape unary `next` already returns.
 *
 * Control-flow narrowing of a flat `ClientRequest` does not refine the overload, so streaming
 * authors that need the stream type narrow with a type guard or pass an already-`serverStream`
 * request.
 */
export interface ClientNext {
  (request: ClientRequest & { readonly kind: 'serverStream' }): AsyncIterable<ClientResponse>;
  (request: ClientRequest): Promise<ClientResponse>;
}

/**
 * Streaming-aware client middleware. Existing unary {@link ClientMiddleware} is assignable to this
 * type, so unary middleware needs no edits; streaming-aware authors opt into the richer
 * {@link ClientNext} and may return a stream for `serverStream` calls.
 */
export type ClientStreamMiddleware = (
  request: ClientRequest,
  next: ClientNext
) => Promise<ClientResponse> | AsyncIterable<ClientResponse>;

/**
 * Compose an array of middleware into a single function that chains them around a final handler.
 * Middleware execute in order: the first middleware in the array is the outermost wrapper.
 *
 * The composition mechanics are identical for unary and streaming calls — each layer only threads
 * the request to `next` and returns whatever `next` returns — so a single chain serves both the
 * unary `invoke` final and the kind-dispatching streaming final.
 */
export function composeMiddleware(
  middleware: readonly ClientMiddleware[],
  final: (request: ClientRequest) => Promise<ClientResponse>
): (request: ClientRequest) => Promise<ClientResponse>;
export function composeMiddleware(
  middleware: readonly ClientStreamMiddleware[],
  final: ClientNext
): ClientNext;
export function composeMiddleware(
  middleware: readonly ClientStreamMiddleware[] | readonly ClientMiddleware[],
  final: (request: ClientRequest) => Promise<ClientResponse> | AsyncIterable<ClientResponse>
): ClientNext {
  let handler = final;

  for (let i = middleware.length - 1; i >= 0; i--) {
    const mw = middleware[i]! as ClientStreamMiddleware;
    const next = handler as ClientNext;
    handler = (request: ClientRequest) => mw(request, next);
  }

  return handler as ClientNext;
}
