import { describe, expect, test } from 'bun:test';

import { loggingMiddleware, timingMiddleware } from './dev.js';
import type { ClientRequest, ClientResponse } from './transport.js';

// -- Helper: create a simple next function --

function makeNext(response: ClientResponse): (request: ClientRequest) => Promise<ClientResponse> {
  return async () => response;
}

describe('loggingMiddleware', () => {
  test('logs before and after calls', async () => {
    const messages: string[] = [];
    const mw = loggingMiddleware({ logger: (msg) => messages.push(msg) });

    const next = makeNext({ output: { ok: true } });

    await mw({ service: 'my-svc', method: 'doThing', kind: 'unary', input: { id: '1' } }, next);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('→ my-svc.doThing');
    expect(messages[1]).toContain('← my-svc.doThing');
    expect(messages[1]).toContain('ok');
  });

  test('uses custom prefix', async () => {
    const messages: string[] = [];
    const mw = loggingMiddleware({
      logger: (msg) => messages.push(msg),
      prefix: '[custom]',
    });

    await mw({ service: 'svc', method: 'ping', kind: 'unary' }, makeNext({ output: 'pong' }));

    expect(messages[0]).toStartWith('[custom]');
    expect(messages[1]).toStartWith('[custom]');
  });

  test('logs error tag on failure', async () => {
    const messages: string[] = [];
    const mw = loggingMiddleware({ logger: (msg) => messages.push(msg) });

    const next = makeNext({
      error: { _tag: 'NotFound', payload: { id: '1' } },
    });

    await mw({ service: 'user-svc', method: 'getUser', kind: 'unary', input: { id: '1' } }, next);

    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain('error: NotFound');
  });
});

describe('timingMiddleware', () => {
  test('calls onCall callback with timing info', async () => {
    const calls: Array<{ service: string; method: string; durationMs: number; ok: boolean }> = [];
    const mw = timingMiddleware({
      onCall: (info) => calls.push(info),
    });

    await mw(
      { service: 'my-svc', method: 'doThing', kind: 'unary', input: {} },
      makeNext({ output: { done: true } })
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.service).toBe('my-svc');
    expect(calls[0]!.method).toBe('doThing');
    expect(calls[0]!.ok).toBe(true);
    expect(typeof calls[0]!.durationMs).toBe('number');
  });

  test('reports ok: false on error response', async () => {
    const calls: Array<{ service: string; method: string; durationMs: number; ok: boolean }> = [];
    const mw = timingMiddleware({ onCall: (info) => calls.push(info) });

    await mw(
      { service: 'svc', method: 'fail', kind: 'unary' },
      makeNext({ error: { _tag: 'Boom' } })
    );

    expect(calls[0]!.ok).toBe(false);
  });

  test('without callback is a passthrough', async () => {
    const mw = timingMiddleware();
    const expectedResponse: ClientResponse = { output: { value: 42 } };

    const result = await mw(
      { service: 'svc', method: 'doThing', kind: 'unary' },
      makeNext(expectedResponse)
    );

    expect(result).toEqual(expectedResponse);
  });
});
