import { describe, expect, test } from 'bun:test';

import { z } from 'zod';

import { Contract } from '../contract/index.js';
import { Client } from './client.js';
import { ContractError } from './error.js';
import type { ClientMiddleware, ClientStreamMiddleware } from './middleware.js';
import type { ClientRequest, ClientResponse, ClientTransport } from './transport.js';

// -- Mock transport --

class MockTransport implements ClientTransport {
  lastRequest?: ClientRequest;
  nextResponse: ClientResponse = { output: undefined };

  async invoke(request: ClientRequest): Promise<ClientResponse> {
    this.lastRequest = request;
    return this.nextResponse;
  }
}

// -- Test contracts --

const IdentitySchema = z.object({
  userId: z.string(),
  principalId: z.string(),
  orgId: z.string().optional(),
});

const ModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
});

const ModelNotFoundPayload = z.object({ modelId: z.string() });

const TestContract = Contract.create('test-svc', {
  version: '1.0.0',
  context: {
    identity: IdentitySchema,
  },
  methods: {
    getModel: {
      kind: 'unary',
      input: z.object({ modelId: z.string() }),
      output: ModelSchema,
      errors: { NotFound: ModelNotFoundPayload },
    },
    listModels: {
      kind: 'unary',
      input: z.object({ provider: z.string().optional() }),
      output: z.object({ data: z.array(ModelSchema) }),
    },
    healthCheck: {
      context: {},
      input: z.void(),
      output: z.object({ ok: z.boolean() }),
    },
    noInputUnary: {
      kind: 'unary',
      output: z.object({ count: z.number() }),
    },
  },
});

const NoCtxContract = Contract.create('no-ctx-svc', {
  version: '1.0.0',
  methods: {
    ping: {
      kind: 'unary',
      output: z.object({ pong: z.boolean() }),
    },
    echo: {
      kind: 'unary',
      input: z.object({ message: z.string() }),
      output: z.object({ message: z.string() }),
    },
  },
});

// -- Tests --

describe('Client.create()', () => {
  test('basic unary call sends correct request to transport', async () => {
    const transport = new MockTransport();
    transport.nextResponse = {
      output: { id: '1', name: 'gpt-4', provider: 'openai' },
    };

    const client = Client.create(TestContract, transport);

    const result = await client.getModel(
      { identity: { userId: 'u1', principalId: 'p1' } },
      { modelId: '1' }
    );

    expect(transport.lastRequest).toBeDefined();
    expect(transport.lastRequest!.service).toBe('test-svc');
    expect(transport.lastRequest!.method).toBe('getModel');
    expect(transport.lastRequest!.kind).toBe('unary');
    expect(transport.lastRequest!.input).toEqual({ modelId: '1' });
    expect(result).toEqual({ id: '1', name: 'gpt-4', provider: 'openai' });
  });

  test('context is serialized into request metadata', async () => {
    const transport = new MockTransport();
    transport.nextResponse = { output: { data: [] } };

    const client = Client.create(TestContract, transport);

    await client.listModels(
      { identity: { userId: 'u1', principalId: 'p1', orgId: 'o1' } },
      { provider: 'openai' }
    );

    expect(transport.lastRequest!.metadata).toBeDefined();
    expect(transport.lastRequest!.metadata!.identity).toBe(
      JSON.stringify({ userId: 'u1', principalId: 'p1', orgId: 'o1' })
    );
  });

  test('methods with empty context skip the context parameter', async () => {
    const transport = new MockTransport();
    transport.nextResponse = { output: { ok: true } };

    const client = Client.create(TestContract, transport);

    const result = await client.healthCheck();

    expect(transport.lastRequest!.service).toBe('test-svc');
    expect(transport.lastRequest!.method).toBe('healthCheck');
    expect(transport.lastRequest!.metadata).toBeUndefined();
    expect(result).toEqual({ ok: true });
  });

  test('methods with void input can be called with only context', async () => {
    const transport = new MockTransport();
    transport.nextResponse = { output: { count: 42 } };

    const client = Client.create(TestContract, transport);

    const result = await client.noInputUnary({
      identity: { userId: 'u1', principalId: 'p1' },
    });

    expect(transport.lastRequest!.input).toBeUndefined();
    expect(result).toEqual({ count: 42 });
  });
});

describe('contract with no context', () => {
  test('methods skip context parameter entirely', async () => {
    const transport = new MockTransport();
    transport.nextResponse = { output: { pong: true } };

    const client = Client.create(NoCtxContract, transport);

    const result = await client.ping();

    expect(transport.lastRequest!.service).toBe('no-ctx-svc');
    expect(transport.lastRequest!.method).toBe('ping');
    expect(transport.lastRequest!.metadata).toBeUndefined();
    expect(result).toEqual({ pong: true });
  });

  test('methods with input but no context receive input directly', async () => {
    const transport = new MockTransport();
    transport.nextResponse = { output: { message: 'hello' } };

    const client = Client.create(NoCtxContract, transport);

    const result = await client.echo({ message: 'hello' });

    expect(transport.lastRequest!.input).toEqual({ message: 'hello' });
    expect(transport.lastRequest!.metadata).toBeUndefined();
    expect(result).toEqual({ message: 'hello' });
  });
});

describe('Client.withContext()', () => {
  test('returns a scoped client with context pre-applied', async () => {
    const transport = new MockTransport();
    transport.nextResponse = {
      output: { id: '1', name: 'gpt-4', provider: 'openai' },
    };

    const client = Client.create(TestContract, transport);
    const scoped = Client.withContext(client, {
      identity: { userId: 'u1', principalId: 'p1' },
    });

    const result = await scoped.getModel({ modelId: '1' });

    expect(transport.lastRequest!.metadata!.identity).toBe(
      JSON.stringify({ userId: 'u1', principalId: 'p1' })
    );
    expect(transport.lastRequest!.input).toEqual({ modelId: '1' });
    expect(result).toEqual({ id: '1', name: 'gpt-4', provider: 'openai' });
  });

  test('scoped client methods with void input can be called with no arguments', async () => {
    const transport = new MockTransport();
    transport.nextResponse = { output: { count: 42 } };

    const client = Client.create(TestContract, transport);
    const scoped = Client.withContext(client, {
      identity: { userId: 'u1', principalId: 'p1' },
    });

    const result = await scoped.noInputUnary();

    expect(transport.lastRequest!.input).toBeUndefined();
    expect(result).toEqual({ count: 42 });
  });

  test('throws when called with a non-branded client', () => {
    expect(() => {
      Client.withContext({} as any, {});
    }).toThrow('Client.withContext() requires a client created by Client.create()');
  });
});

describe('error strategy: throw (default)', () => {
  test('throws ContractError when transport returns an error', async () => {
    const transport = new MockTransport();
    transport.nextResponse = {
      error: { _tag: 'NotFound', payload: { modelId: '999' }, message: 'Model not found' },
    };

    const client = Client.create(TestContract, transport);

    try {
      await client.getModel({ identity: { userId: 'u1', principalId: 'p1' } }, { modelId: '999' });
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(ContractError);
      const contractErr = err as ContractError;
      expect(contractErr._tag).toBe('NotFound');
      expect(contractErr.payload).toEqual({ modelId: '999' });
      expect(contractErr.message).toBe('Model not found');
    }
  });

  test('ContractError has default message when none provided', async () => {
    const transport = new MockTransport();
    transport.nextResponse = {
      error: { _tag: 'NotFound', payload: { modelId: '1' } },
    };

    const client = Client.create(TestContract, transport);

    try {
      await client.getModel({ identity: { userId: 'u1', principalId: 'p1' } }, { modelId: '1' });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ContractError);
      expect((err as ContractError).message).toBe('ContractError: NotFound');
    }
  });
});

describe('error strategy: result', () => {
  test('returns ok result on success', async () => {
    const transport = new MockTransport();
    transport.nextResponse = { output: { ok: true } };

    const client = Client.create(TestContract, transport, { errors: 'result' });

    const result = await client.healthCheck();

    expect(result).toEqual({ ok: true, value: { ok: true } });
  });

  test('returns error result on failure', async () => {
    const transport = new MockTransport();
    transport.nextResponse = {
      error: { _tag: 'NotFound', payload: { modelId: '999' } },
    };

    const client = Client.create(TestContract, transport, { errors: 'result' });

    const result = await client.getModel(
      { identity: { userId: 'u1', principalId: 'p1' } },
      { modelId: '999' }
    );

    expect(result).toEqual({
      ok: false,
      error: { _tag: 'NotFound', payload: { modelId: '999' } },
    });
  });
});

describe('middleware', () => {
  test('middleware can modify request metadata', async () => {
    const transport = new MockTransport();
    transport.nextResponse = { output: { pong: true } };

    const addHeader: ClientMiddleware = async (request, next) => {
      return next({
        ...request,
        metadata: { ...request.metadata, 'x-request-id': '12345' },
      });
    };

    const client = Client.create(NoCtxContract, transport, { middleware: [addHeader] });

    await client.ping();

    expect(transport.lastRequest!.metadata).toEqual({ 'x-request-id': '12345' });
  });

  test('middleware can modify response', async () => {
    const transport = new MockTransport();
    transport.nextResponse = { output: { pong: true } };

    const transform: ClientMiddleware = async (request, next) => {
      const response = await next(request);
      return { ...response, output: { pong: false } };
    };

    const client = Client.create(NoCtxContract, transport, { middleware: [transform] });

    const result = await client.ping();

    expect(result).toEqual({ pong: false });
  });

  test('middleware execute in order (first added = outermost)', async () => {
    const transport = new MockTransport();
    transport.nextResponse = { output: { pong: true } };

    const order: string[] = [];

    const first: ClientMiddleware = async (request, next) => {
      order.push('first-before');
      const response = await next(request);
      order.push('first-after');
      return response;
    };

    const second: ClientMiddleware = async (request, next) => {
      order.push('second-before');
      const response = await next(request);
      order.push('second-after');
      return response;
    };

    const client = Client.create(NoCtxContract, transport, {
      middleware: [first, second],
    });

    await client.ping();

    expect(order).toEqual(['first-before', 'second-before', 'second-after', 'first-after']);
  });

  test('middleware applies to scoped clients', async () => {
    const transport = new MockTransport();
    transport.nextResponse = {
      output: { id: '1', name: 'gpt-4', provider: 'openai' },
    };

    const addHeader: ClientMiddleware = async (request, next) => {
      return next({
        ...request,
        metadata: { ...request.metadata, 'x-trace-id': 'trace-abc' },
      });
    };

    const client = Client.create(TestContract, transport, { middleware: [addHeader] });
    const scoped = Client.withContext(client, {
      identity: { userId: 'u1', principalId: 'p1' },
    });

    await scoped.getModel({ modelId: '1' });

    expect(transport.lastRequest!.metadata!['x-trace-id']).toBe('trace-abc');
    expect(transport.lastRequest!.metadata!.identity).toBeDefined();
  });
});

describe('streaming methods', () => {
  test('server stream throws when transport lacks invokeServerStream', async () => {
    const StreamContract = Contract.create('stream-svc', {
      version: '1.0.0',
      methods: {
        watchModels: {
          kind: 'serverStream',
          output: z.object({ id: z.string() }),
        },
      },
    });

    const transport = new MockTransport();
    const client = Client.create(StreamContract, transport);

    expect(() => {
      (client as any).watchModels();
    }).toThrow('Transport does not support server streaming for method "watchModels".');
  });

  test('client stream throws when transport lacks invokeClientStream', async () => {
    const StreamContract = Contract.create('cstream-svc', {
      version: '1.0.0',
      methods: {
        upload: {
          kind: 'clientStream',
          input: z.object({ chunk: z.string() }),
          output: z.object({ total: z.number() }),
        },
      },
    });

    const transport = new MockTransport();
    const client = Client.create(StreamContract, transport);

    await expect((client as any).upload((async function* () {})())).rejects.toThrow(
      'Transport does not support client streaming for method "upload".'
    );
  });

  test('duplex throws when transport lacks invokeDuplex', async () => {
    const StreamContract = Contract.create('duplex-svc', {
      version: '1.0.0',
      methods: {
        chat: {
          kind: 'duplex',
          input: z.object({ msg: z.string() }),
          output: z.object({ reply: z.string() }),
        },
      },
    });

    const transport = new MockTransport();
    const client = Client.create(StreamContract, transport);

    expect(() => {
      (client as any).chat((async function* () {})());
    }).toThrow('Transport does not support duplex streaming for method "chat".');
  });
});

// -- serverStream middleware (issue 0001) --

class StreamMockTransport implements ClientTransport {
  unaryRequest?: ClientRequest;
  serverStreamRequest?: ClientRequest;
  serverStreamCalls = 0;
  responses: ClientResponse[] = [{ output: { id: 'a' } }, { output: { id: 'b' } }];

  async invoke(request: ClientRequest): Promise<ClientResponse> {
    this.unaryRequest = request;
    return { output: undefined };
  }

  invokeServerStream(request: ClientRequest): AsyncIterable<ClientResponse> {
    // Record at call time (not at first iteration) so tests can assert the transport was/wasn't hit.
    this.serverStreamRequest = request;
    this.serverStreamCalls++;
    const responses = this.responses;
    return (async function* () {
      for (const r of responses) yield r;
    })();
  }
}

const StreamContract = Contract.create('stream-mw-svc', {
  version: '1.0.0',
  methods: {
    watch: {
      kind: 'serverStream',
      input: z.object({ topic: z.string() }),
      output: z.object({ id: z.string() }),
    },
  },
});

const StreamCtxContract = Contract.create('stream-ctx-mw-svc', {
  version: '1.0.0',
  context: { identity: IdentitySchema },
  methods: {
    watch: {
      kind: 'serverStream',
      output: z.object({ id: z.string() }),
    },
  },
});

describe('serverStream middleware', () => {
  test('middleware runs for a serverStream call and mutated metadata reaches the transport request', async () => {
    const transport = new StreamMockTransport();

    const inject: ClientStreamMiddleware = (request, next) =>
      next({ ...request, metadata: { ...request.metadata, 'x-trace': 'abc' } });

    const client = Client.create(StreamContract, transport, { middleware: [inject] });

    const results: unknown[] = [];
    for await (const item of client.watch({ topic: 't' })) {
      results.push(item);
    }

    expect(transport.serverStreamRequest).toBeDefined();
    expect(transport.serverStreamRequest!.kind).toBe('serverStream');
    expect(transport.serverStreamRequest!.metadata!['x-trace']).toBe('abc');
    expect(results).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  test('middleware order for serverStream is "first in the array is outermost"', async () => {
    const transport = new StreamMockTransport();
    const order: string[] = [];

    const first: ClientStreamMiddleware = (request, next) => {
      order.push('first');
      return next(request);
    };
    const second: ClientStreamMiddleware = (request, next) => {
      order.push('second');
      return next(request);
    };

    const client = Client.create(StreamContract, transport, { middleware: [first, second] });

    for await (const _ of client.watch({ topic: 't' })) {
      // drain
    }

    expect(order).toEqual(['first', 'second']);
  });

  test('streaming-aware middleware can wrap the response stream', async () => {
    const transport = new StreamMockTransport();
    const seen: unknown[] = [];

    const observe: ClientStreamMiddleware = (request, next) => {
      const stream = next(request as ClientRequest & { kind: 'serverStream' });
      return (async function* () {
        for await (const response of stream) {
          seen.push(response.output);
          yield response;
        }
      })();
    };

    const client = Client.create(StreamContract, transport, { middleware: [observe] });

    const results: unknown[] = [];
    for await (const item of client.watch({ topic: 't' })) {
      results.push(item);
    }

    expect(results).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(seen).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  test('a middleware that does not call next short-circuits with a single terminal error', async () => {
    const transport = new StreamMockTransport();

    const block: ClientStreamMiddleware = async () => ({
      error: { _tag: 'Blocked', message: 'denied' },
    });

    const client = Client.create(StreamContract, transport, { middleware: [block] });

    const results: unknown[] = [];
    let caught: unknown;
    try {
      for await (const item of client.watch({ topic: 't' })) {
        results.push(item);
      }
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ContractError);
    expect((caught as ContractError)._tag).toBe('Blocked');
    expect(results).toEqual([]);
    // Short-circuit must never reach the transport — no stream, no hang.
    expect(transport.serverStreamCalls).toBe(0);
  });

  test('scoped clients apply middleware to serverStream calls', async () => {
    const transport = new StreamMockTransport();

    const inject: ClientStreamMiddleware = (request, next) =>
      next({ ...request, metadata: { ...request.metadata, 'x-trace': 'scoped' } });

    const client = Client.create(StreamCtxContract, transport, { middleware: [inject] });
    const scoped = Client.withContext(client, {
      identity: { userId: 'u1', principalId: 'p1' },
    });

    for await (const _ of scoped.watch()) {
      // drain
    }

    expect(transport.serverStreamRequest!.metadata!['x-trace']).toBe('scoped');
    expect(transport.serverStreamRequest!.metadata!.identity).toBeDefined();
  });
});
