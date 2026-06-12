import { describe, expect, test } from 'bun:test';

import { TestTransport } from './test.js';
import type { ClientRequest } from './transport.js';

describe('TestTransport', () => {
  test('records calls with full request details', async () => {
    const transport = new TestTransport();
    transport.defaultResponse({ output: 'ok' });

    const request: ClientRequest = {
      service: 'my-svc',
      method: 'doThing',
      kind: 'unary',
      input: { id: '1' },
      metadata: { 'x-trace': 'abc' },
    };

    await transport.invoke(request);

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]).toEqual(request);
  });

  test('.on(method).returns(output) returns configured response', async () => {
    const transport = new TestTransport();
    transport.on('getUser').returns({ id: '1', name: 'Alice' });

    const response = await transport.invoke({
      service: 'user-svc',
      method: 'getUser',
      kind: 'unary',
      input: { id: '1' },
    });

    expect(response).toEqual({ output: { id: '1', name: 'Alice' } });
  });

  test('.on(method).throws(tag, payload) returns error response', async () => {
    const transport = new TestTransport();
    transport.on('getUser').throws('NotFound', { userId: '999' });

    const response = await transport.invoke({
      service: 'user-svc',
      method: 'getUser',
      kind: 'unary',
      input: { id: '999' },
    });

    expect(response).toEqual({
      error: { _tag: 'NotFound', payload: { userId: '999' } },
    });
  });

  test('returns no-response error for unconfigured methods', async () => {
    const transport = new TestTransport();

    const response = await transport.invoke({
      service: 'user-svc',
      method: 'unknownMethod',
      kind: 'unary',
    });

    expect(response.error).toBeDefined();
    expect(response.error!._tag).toBe('__test_no_response__');
    expect(response.error!.message).toBe('No response configured for method: unknownMethod');
  });

  test('.defaultResponse() provides fallback for unmatched methods', async () => {
    const transport = new TestTransport();
    transport.defaultResponse({ output: { fallback: true } });

    const response = await transport.invoke({
      service: 'any-svc',
      method: 'anyMethod',
      kind: 'unary',
    });

    expect(response).toEqual({ output: { fallback: true } });
  });

  test('.reset() clears calls and configured responses', async () => {
    const transport = new TestTransport();
    transport.on('getUser').returns({ id: '1' });
    transport.defaultResponse({ output: 'default' });

    await transport.invoke({
      service: 'svc',
      method: 'getUser',
      kind: 'unary',
    });

    expect(transport.calls).toHaveLength(1);

    transport.reset();

    expect(transport.calls).toHaveLength(0);

    // Configured response should be cleared — should get no-response error
    const response = await transport.invoke({
      service: 'svc',
      method: 'getUser',
      kind: 'unary',
    });

    expect(response.error).toBeDefined();
    expect(response.error!._tag).toBe('__test_no_response__');
  });

  test('multiple calls accumulate in calls array', async () => {
    const transport = new TestTransport();
    transport.defaultResponse({ output: 'ok' });

    await transport.invoke({ service: 'svc', method: 'a', kind: 'unary' });
    await transport.invoke({ service: 'svc', method: 'b', kind: 'unary' });
    await transport.invoke({ service: 'svc', method: 'c', kind: 'unary' });

    expect(transport.calls).toHaveLength(3);
    expect(transport.calls[0]!.method).toBe('a');
    expect(transport.calls[1]!.method).toBe('b');
    expect(transport.calls[2]!.method).toBe('c');
  });
});
