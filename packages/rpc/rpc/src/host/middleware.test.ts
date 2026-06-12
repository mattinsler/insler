import { describe, expect, test } from 'bun:test';

import { expectTypeOf } from 'expect-type';

import type { HostMiddleware, HostNext, HostStreamMiddleware } from './middleware.js';
import type { HostRequest, HostResponse } from './transport.js';

// Type-level guarantees for the streaming middleware contract (issue 0001, AC1).
// These assertions are enforced by `tsc --noEmit`; the runtime `expect` below is incidental.

describe('host streaming middleware contract (types)', () => {
  test('existing unary HostMiddleware compiles verbatim and is assignable to the streaming shape', () => {
    // Authored exactly as a unary middleware author would today — no edits.
    const unaryMw: HostMiddleware = async (request, next) => {
      return next({ ...request, metadata: { ...request.metadata, 'x-id': '1' } });
    };

    const asStream: HostStreamMiddleware = unaryMw;
    const asStreamArray: HostStreamMiddleware[] = [unaryMw];

    expectTypeOf<HostMiddleware>().toExtend<HostStreamMiddleware>();
    expect(typeof asStream).toBe('function');
    expect(asStreamArray).toHaveLength(1);
  });

  test('next is kind-discriminated by request kind', () => {
    // Body is type-checked by tsc but never invoked at runtime, so `next` is never called.
    function _typeOnly(
      next: HostNext,
      serverStreamRequest: HostRequest & { kind: 'serverStream' },
      unaryRequest: HostRequest
    ) {
      // serverStream request → a stream of responses
      expectTypeOf(next(serverStreamRequest)).toEqualTypeOf<AsyncIterable<HostResponse>>();
      // every other kind → a single response
      expectTypeOf(next(unaryRequest)).toEqualTypeOf<Promise<HostResponse>>();
    }

    expect(typeof _typeOnly).toBe('function');
  });
});
