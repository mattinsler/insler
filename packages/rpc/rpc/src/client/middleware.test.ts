import { describe, expect, test } from 'bun:test';

import { expectTypeOf } from 'expect-type';

import type { ClientMiddleware, ClientNext, ClientStreamMiddleware } from './middleware.js';
import type { ClientRequest, ClientResponse } from './transport.js';

// Type-level guarantees for the streaming middleware contract (issue 0001, AC1).
// These assertions are enforced by `tsc --noEmit`; the runtime `expect` below is incidental.

describe('client streaming middleware contract (types)', () => {
  test('existing unary ClientMiddleware compiles verbatim and is assignable to the streaming shape', () => {
    // Authored exactly as a unary middleware author would today — no edits.
    const unaryMw: ClientMiddleware = async (request, next) => {
      return next({ ...request, metadata: { ...request.metadata, 'x-id': '1' } });
    };

    // The unary signature is assignable to the streaming-capable signature, so existing
    // middleware (and arrays of it) flow through the generalized chain unchanged.
    const asStream: ClientStreamMiddleware = unaryMw;
    const asStreamArray: ClientStreamMiddleware[] = [unaryMw];

    expectTypeOf<ClientMiddleware>().toExtend<ClientStreamMiddleware>();
    expect(typeof asStream).toBe('function');
    expect(asStreamArray).toHaveLength(1);
  });

  test('next is kind-discriminated by request kind', () => {
    // Body is type-checked by tsc but never invoked at runtime, so `next` is never called.
    function _typeOnly(
      next: ClientNext,
      serverStreamRequest: ClientRequest & { kind: 'serverStream' },
      unaryRequest: ClientRequest
    ) {
      // serverStream request → a stream of responses
      expectTypeOf(next(serverStreamRequest)).toEqualTypeOf<AsyncIterable<ClientResponse>>();
      // every other kind → a single response
      expectTypeOf(next(unaryRequest)).toEqualTypeOf<Promise<ClientResponse>>();
    }

    expect(typeof _typeOnly).toBe('function');
  });
});
