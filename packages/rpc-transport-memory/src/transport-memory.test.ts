import { describe, expect, test } from 'bun:test';

import { Client } from '@insler/rpc-client';
import type { ClientStreamMiddleware, ClientTransport } from '@insler/rpc-client';
import { Contract } from '@insler/rpc-contract';
import { Host } from '@insler/rpc-host';
import type {
  HostHandler,
  HostMethodRegistration,
  HostStreamMiddleware,
  HostTransport,
} from '@insler/rpc-host';
import { z } from 'zod';

import { MemoryBus } from './bus.js';
import { MemoryClientTransport } from './client-transport.js';
import { MemoryHostTransport } from './host-transport.js';
import { createMemoryTransport } from './index.js';

// --------------------------------------------------------------------------
// Transport-level tests
// --------------------------------------------------------------------------

function unaryReg(method: string, handler: HostHandler): HostMethodRegistration {
  return { method, kind: 'unary', handler };
}

describe('MemoryBus', () => {
  test('register and invoke: routes request to handler', async () => {
    const bus = new MemoryBus();
    const handler: HostHandler = async (req) => ({
      output: { echo: req.input },
    });

    bus.register('svc', 'method', unaryReg('method', handler));

    const response = await bus.invoke('svc', 'method', {
      service: 'svc',
      method: 'method',
      kind: 'unary',
      input: 'hello',
    });

    expect(response.output).toEqual({ echo: 'hello' });
    expect(response.error).toBeUndefined();
  });

  test('unregister: removes handler so subsequent invoke returns error', async () => {
    const bus = new MemoryBus();
    const handler: HostHandler = async () => ({ output: 'ok' });

    const unregister = bus.register('svc', 'method', unaryReg('method', handler));

    // Works before unregister
    const before = await bus.invoke('svc', 'method', {
      service: 'svc',
      method: 'method',
      kind: 'unary',
    });
    expect(before.output).toBe('ok');

    // Unregister
    unregister();

    // Returns error after unregister
    const after = await bus.invoke('svc', 'method', {
      service: 'svc',
      method: 'method',
      kind: 'unary',
    });
    expect(after.error).toBeDefined();
    expect(after.error!._tag).toBe('__not_found__');
  });

  test('invoke unregistered: returns not-found error', async () => {
    const bus = new MemoryBus();

    const response = await bus.invoke('missing', 'method', {
      service: 'missing',
      method: 'method',
      kind: 'unary',
    });

    expect(response.error).toBeDefined();
    expect(response.error!._tag).toBe('__not_found__');
    expect(response.error!.message).toContain('missing.method');
  });

  test('multiple services: routes to correct handler', async () => {
    const bus = new MemoryBus();

    bus.register(
      'alpha',
      'run',
      unaryReg('run', async () => ({ output: 'alpha' }))
    );
    bus.register(
      'beta',
      'run',
      unaryReg('run', async () => ({ output: 'beta' }))
    );

    const alphaResp = await bus.invoke('alpha', 'run', {
      service: 'alpha',
      method: 'run',
      kind: 'unary',
    });
    const betaResp = await bus.invoke('beta', 'run', {
      service: 'beta',
      method: 'run',
      kind: 'unary',
    });

    expect(alphaResp.output).toBe('alpha');
    expect(betaResp.output).toBe('beta');
  });

  test('duplicate registration: throws error', () => {
    const bus = new MemoryBus();
    bus.register(
      'svc',
      'method',
      unaryReg('method', async () => ({ output: 'ok' }))
    );

    expect(() => {
      bus.register(
        'svc',
        'method',
        unaryReg('method', async () => ({ output: 'duplicate' }))
      );
    }).toThrow("Handler already registered for 'svc.method'");
  });
});

describe('MemoryClientTransport', () => {
  test('invoke routes through the bus and returns response', async () => {
    const bus = new MemoryBus();
    bus.register(
      'svc',
      'echo',
      unaryReg('echo', async (req) => ({
        output: req.input,
      }))
    );

    const transport: ClientTransport = new MemoryClientTransport(bus);

    const response = await transport.invoke({
      service: 'svc',
      method: 'echo',
      kind: 'unary',
      input: { message: 'hi' },
    });

    expect(response.output).toEqual({ message: 'hi' });
    expect(response.error).toBeUndefined();
  });

  test('invoke passes metadata through to host request', async () => {
    const bus = new MemoryBus();
    let receivedMetadata: Record<string, string> | undefined;
    bus.register(
      'svc',
      'check',
      unaryReg('check', async (req) => {
        receivedMetadata = req.metadata;
        return { output: 'ok' };
      })
    );

    const transport: ClientTransport = new MemoryClientTransport(bus);

    await transport.invoke({
      service: 'svc',
      method: 'check',
      kind: 'unary',
      metadata: { 'x-trace': '123' },
    });

    expect(receivedMetadata).toEqual({ 'x-trace': '123' });
  });
});

describe('MemoryHostTransport', () => {
  test('register adds handlers to the bus', async () => {
    const bus = new MemoryBus();
    const transport: HostTransport = new MemoryHostTransport(bus);

    await transport.register({
      service: 'svc',
      methods: [
        {
          method: 'alpha',
          kind: 'unary',
          handler: async () => ({ output: 'a' }),
        },
        {
          method: 'beta',
          kind: 'unary',
          handler: async () => ({ output: 'b' }),
        },
      ],
    });

    const alphaResp = await bus.invoke('svc', 'alpha', {
      service: 'svc',
      method: 'alpha',
      kind: 'unary',
    });
    const betaResp = await bus.invoke('svc', 'beta', {
      service: 'svc',
      method: 'beta',
      kind: 'unary',
    });

    expect(alphaResp.output).toBe('a');
    expect(betaResp.output).toBe('b');
  });

  test('unregister removes all method handlers', async () => {
    const bus = new MemoryBus();
    const transport: HostTransport = new MemoryHostTransport(bus);

    const unregister = await transport.register({
      service: 'svc',
      methods: [
        {
          method: 'alpha',
          kind: 'unary',
          handler: async () => ({ output: 'a' }),
        },
        {
          method: 'beta',
          kind: 'unary',
          handler: async () => ({ output: 'b' }),
        },
      ],
    });

    await unregister();

    const alphaResp = await bus.invoke('svc', 'alpha', {
      service: 'svc',
      method: 'alpha',
      kind: 'unary',
    });
    const betaResp = await bus.invoke('svc', 'beta', {
      service: 'svc',
      method: 'beta',
      kind: 'unary',
    });

    expect(alphaResp.error).toBeDefined();
    expect(alphaResp.error!._tag).toBe('__not_found__');
    expect(betaResp.error).toBeDefined();
    expect(betaResp.error!._tag).toBe('__not_found__');
  });
});

describe('createMemoryTransport', () => {
  test('returns connected bus, client, and host', () => {
    const { bus, client, host } = createMemoryTransport();
    expect(bus).toBeInstanceOf(MemoryBus);
    expect(client).toBeInstanceOf(MemoryClientTransport);
    expect(host).toBeInstanceOf(MemoryHostTransport);
  });
});

// --------------------------------------------------------------------------
// End-to-end integration tests
// --------------------------------------------------------------------------

describe('end-to-end: contract + client + host + memory transport', () => {
  const Calculator = Contract.create('calculator', {
    version: '1.0.0',
    methods: {
      add: {
        input: z.object({ a: z.number(), b: z.number() }),
        output: z.object({ result: z.number() }),
      },
      divide: {
        input: z.object({ a: z.number(), b: z.number() }),
        output: z.object({ result: z.number() }),
        errors: {
          DivisionByZero: z.object({ message: z.string() }),
        },
      },
    },
  });

  test('basic unary call: add', async () => {
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    const host = await Host.create(
      Calculator,
      {
        add: async (input: { a: number; b: number }) => ({
          result: input.a + input.b,
        }),
        divide: async (input: { a: number; b: number }) => {
          if (input.b === 0) {
            throw {
              _tag: 'DivisionByZero',
              payload: { message: 'Cannot divide by zero' },
            };
          }
          return { result: input.a / input.b };
        },
      } as any,
      hostTransport
    );

    const client = Client.create(Calculator, clientTransport);

    const sum = await client.add({ a: 3, b: 4 });
    expect(sum).toEqual({ result: 7 });

    const quotient = await client.divide({ a: 10, b: 2 });
    expect(quotient).toEqual({ result: 5 });

    await host.stop();
  });

  test('error handling: contract errors propagate to client', async () => {
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    const host = await Host.create(
      Calculator,
      {
        add: async (input: { a: number; b: number }) => ({
          result: input.a + input.b,
        }),
        divide: async (input: { a: number; b: number }) => {
          if (input.b === 0) {
            throw {
              _tag: 'DivisionByZero',
              payload: { message: 'Cannot divide by zero' },
            };
          }
          return { result: input.a / input.b };
        },
      } as any,
      hostTransport
    );

    const client = Client.create(Calculator, clientTransport);

    try {
      await client.divide({ a: 1, b: 0 });
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err._tag).toBe('DivisionByZero');
      expect(err.payload).toEqual({ message: 'Cannot divide by zero' });
    }

    await host.stop();
  });

  test('input validation: rejects invalid input', async () => {
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    const host = await Host.create(
      Calculator,
      {
        add: async (input: { a: number; b: number }) => ({
          result: input.a + input.b,
        }),
        divide: async (input: { a: number; b: number }) => ({
          result: input.a / input.b,
        }),
      } as any,
      hostTransport
    );

    const client = Client.create(Calculator, clientTransport);

    try {
      await (client as any).add({ a: 'not-a-number', b: 4 });
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err._tag).toBe('__validation__');
    }

    await host.stop();
  });

  test('host stop: unregisters handlers so calls return error', async () => {
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    const host = await Host.create(
      Calculator,
      {
        add: async (input: { a: number; b: number }) => ({
          result: input.a + input.b,
        }),
        divide: async (input: { a: number; b: number }) => ({
          result: input.a / input.b,
        }),
      } as any,
      hostTransport
    );

    const client = Client.create(Calculator, clientTransport);

    // Works before stop
    const sum = await client.add({ a: 1, b: 2 });
    expect(sum).toEqual({ result: 3 });

    await host.stop();

    // Fails after stop
    try {
      await client.add({ a: 1, b: 2 });
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err._tag).toBe('__not_found__');
    }
  });
});

describe('end-to-end: contract with context', () => {
  const AuthedService = Contract.create('authed', {
    version: '1.0.0',
    context: {
      identity: z.object({ userId: z.string() }),
    },
    methods: {
      whoami: {
        output: z.object({ userId: z.string() }),
      },
      greet: {
        input: z.object({ name: z.string() }),
        output: z.object({ greeting: z.string() }),
      },
    },
  });

  test('context is passed through to handler', async () => {
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    const host = await Host.create(
      AuthedService,
      {
        whoami: async (ctx: { identity: { userId: string } }) => ({
          userId: ctx.identity.userId,
        }),
        greet: async (ctx: { identity: { userId: string } }, input: { name: string }) => ({
          greeting: `Hello ${input.name}, you are ${ctx.identity.userId}`,
        }),
      } as any,
      hostTransport
    );

    const client = Client.create(AuthedService, clientTransport);

    const result = await client.whoami({ identity: { userId: 'user-123' } });
    expect(result).toEqual({ userId: 'user-123' });

    const greeting = await client.greet({ identity: { userId: 'user-456' } }, { name: 'Alice' });
    expect(greeting).toEqual({
      greeting: 'Hello Alice, you are user-456',
    });

    await host.stop();
  });

  test('withContext: scoped client pre-applies context', async () => {
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    const host = await Host.create(
      AuthedService,
      {
        whoami: async (ctx: { identity: { userId: string } }) => ({
          userId: ctx.identity.userId,
        }),
        greet: async (ctx: { identity: { userId: string } }, input: { name: string }) => ({
          greeting: `Hello ${input.name}, you are ${ctx.identity.userId}`,
        }),
      } as any,
      hostTransport
    );

    const client = Client.create(AuthedService, clientTransport);
    const scoped = Client.withContext(client, {
      identity: { userId: 'scoped-user' },
    });

    const result = await scoped.whoami();
    expect(result).toEqual({ userId: 'scoped-user' });

    const greeting = await scoped.greet({ name: 'Bob' });
    expect(greeting).toEqual({
      greeting: 'Hello Bob, you are scoped-user',
    });

    await host.stop();
  });
});

describe('end-to-end: server streaming', () => {
  const EventService = Contract.create('events', {
    version: '1.0.0',
    methods: {
      watch: {
        kind: 'serverStream' as const,
        input: z.object({ topic: z.string() }),
        output: z.object({ event: z.string(), seq: z.number() }),
      },
    },
  });

  test('server stream: yields multiple outputs', async () => {
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    const host = await Host.create(
      EventService,
      {
        async *watch(input: { topic: string }) {
          yield { event: `${input.topic}:start`, seq: 1 };
          yield { event: `${input.topic}:data`, seq: 2 };
          yield { event: `${input.topic}:end`, seq: 3 };
        },
      } as any,
      hostTransport
    );

    const client = Client.create(EventService, clientTransport);
    const results: unknown[] = [];
    for await (const item of client.watch({ topic: 'test' })) {
      results.push(item);
    }

    expect(results).toEqual([
      { event: 'test:start', seq: 1 },
      { event: 'test:data', seq: 2 },
      { event: 'test:end', seq: 3 },
    ]);

    await host.stop();
  });

  test('server stream: empty stream yields nothing', async () => {
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    const host = await Host.create(
      EventService,
      {
        async *watch() {
          // yield nothing
        },
      } as any,
      hostTransport
    );

    const client = Client.create(EventService, clientTransport);
    const results: unknown[] = [];
    for await (const item of client.watch({ topic: 'empty' })) {
      results.push(item);
    }

    expect(results).toEqual([]);
    await host.stop();
  });

  test('server stream: handler error propagates as ContractError', async () => {
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    const host = await Host.create(
      EventService,
      {
        async *watch() {
          yield { event: 'before-error', seq: 1 };
          throw { _tag: 'StreamFailed', payload: { reason: 'oops' } };
        },
      } as any,
      hostTransport
    );

    const client = Client.create(EventService, clientTransport);
    const results: unknown[] = [];
    try {
      for await (const item of client.watch({ topic: 'fail' })) {
        results.push(item);
      }
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err._tag).toBe('StreamFailed');
      expect(err.payload).toEqual({ reason: 'oops' });
    }

    expect(results).toEqual([{ event: 'before-error', seq: 1 }]);
    await host.stop();
  });
});

describe('end-to-end: serverStream middleware composes across the wire', () => {
  const EventService = Contract.create('mw-events', {
    version: '1.0.0',
    methods: {
      watch: {
        kind: 'serverStream' as const,
        input: z.object({ topic: z.string() }),
        output: z.object({ event: z.string() }),
      },
    },
  });

  test('client + host middleware both run for a serverStream call; injected header crosses the wire', async () => {
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    let observedByHostMw: string | undefined;

    const clientMw: ClientStreamMiddleware = (request, next) =>
      next({ ...request, metadata: { ...request.metadata, 'x-trace': 'wire-abc' } });

    const hostMw: HostStreamMiddleware = (request, next) => {
      observedByHostMw = request.metadata?.['x-trace'];
      return next(request);
    };

    const host = await Host.create(
      EventService,
      {
        async *watch(input: { topic: string }) {
          yield { event: `${input.topic}:1` };
          yield { event: `${input.topic}:2` };
        },
      } as any,
      hostTransport,
      { middleware: [hostMw] }
    );

    const client = Client.create(EventService, clientTransport, { middleware: [clientMw] });

    const results: unknown[] = [];
    for await (const item of client.watch({ topic: 'go' })) {
      results.push(item);
    }

    expect(results).toEqual([{ event: 'go:1' }, { event: 'go:2' }]);
    // Client middleware injected the header; it crossed the memory transport and was observed by
    // host middleware — proving both sides' middleware compose for a serverStream call.
    expect(observedByHostMw).toBe('wire-abc');

    await host.stop();
  });
});

describe('end-to-end: server streaming with context', () => {
  const ContextStreamService = Contract.create('ctx-stream', {
    version: '1.0.0',
    context: {
      identity: z.object({ userId: z.string() }),
    },
    methods: {
      watchForUser: {
        kind: 'serverStream' as const,
        output: z.object({ msg: z.string() }),
      },
    },
  });

  test('server stream with context: context is passed to handler', async () => {
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    const host = await Host.create(
      ContextStreamService,
      {
        async *watchForUser(ctx: { identity: { userId: string } }) {
          yield { msg: `hello ${ctx.identity.userId}` };
        },
      } as any,
      hostTransport
    );

    const client = Client.create(ContextStreamService, clientTransport);
    const results: unknown[] = [];
    for await (const item of client.watchForUser({ identity: { userId: 'alice' } })) {
      results.push(item);
    }

    expect(results).toEqual([{ msg: 'hello alice' }]);
    await host.stop();
  });

  test('server stream with scoped client: context pre-applied', async () => {
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    const host = await Host.create(
      ContextStreamService,
      {
        async *watchForUser(ctx: { identity: { userId: string } }) {
          yield { msg: `scoped:${ctx.identity.userId}` };
        },
      } as any,
      hostTransport
    );

    const client = Client.create(ContextStreamService, clientTransport);
    const scoped = Client.withContext(client, { identity: { userId: 'bob' } });
    const results: unknown[] = [];
    for await (const item of scoped.watchForUser()) {
      results.push(item);
    }

    expect(results).toEqual([{ msg: 'scoped:bob' }]);
    await host.stop();
  });
});

describe('end-to-end: client streaming', () => {
  const AggregateService = Contract.create('aggregate', {
    version: '1.0.0',
    methods: {
      sum: {
        kind: 'clientStream' as const,
        input: z.object({ value: z.number() }),
        output: z.object({ total: z.number() }),
      },
    },
  });

  test('client stream: aggregates input stream into single output', async () => {
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    const host = await Host.create(
      AggregateService,
      {
        async sum(inputStream: AsyncIterable<{ value: number }>) {
          let total = 0;
          for await (const item of inputStream) {
            total += item.value;
          }
          return { total };
        },
      } as any,
      hostTransport
    );

    const client = Client.create(AggregateService, clientTransport);

    async function* values() {
      yield { value: 10 };
      yield { value: 20 };
      yield { value: 30 };
    }

    const result = await client.sum(values());
    expect(result).toEqual({ total: 60 });
    await host.stop();
  });

  test('client stream: result mode returns ok wrapper', async () => {
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    const host = await Host.create(
      AggregateService,
      {
        async sum(inputStream: AsyncIterable<{ value: number }>) {
          let total = 0;
          for await (const item of inputStream) {
            total += item.value;
          }
          return { total };
        },
      } as any,
      hostTransport
    );

    const client = Client.create(AggregateService, clientTransport, { errors: 'result' });

    async function* values() {
      yield { value: 5 };
      yield { value: 15 };
    }

    const result = await client.sum(values());
    expect(result).toEqual({ ok: true, value: { total: 20 } });
    await host.stop();
  });

  test('client stream: input validation rejects bad items', async () => {
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    const host = await Host.create(
      AggregateService,
      {
        async sum(inputStream: AsyncIterable<{ value: number }>) {
          let total = 0;
          for await (const item of inputStream) {
            total += item.value;
          }
          return { total };
        },
      } as any,
      hostTransport
    );

    const client = Client.create(AggregateService, clientTransport);

    async function* badValues() {
      yield { value: 10 };
      yield { bad: 'not a number' } as any;
    }

    try {
      await client.sum(badValues());
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err._tag).toBe('__validation__');
    }
    await host.stop();
  });
});

describe('end-to-end: duplex streaming', () => {
  const EchoService = Contract.create('echo', {
    version: '1.0.0',
    methods: {
      echo: {
        kind: 'duplex' as const,
        input: z.object({ msg: z.string() }),
        output: z.object({ reply: z.string() }),
      },
    },
  });

  test('duplex: transforms each input into an output', async () => {
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    const host = await Host.create(
      EchoService,
      {
        async *echo(inputStream: AsyncIterable<{ msg: string }>) {
          for await (const item of inputStream) {
            yield { reply: `echo:${item.msg}` };
          }
        },
      } as any,
      hostTransport
    );

    const client = Client.create(EchoService, clientTransport);

    async function* inputs() {
      yield { msg: 'hello' };
      yield { msg: 'world' };
    }

    const results: unknown[] = [];
    for await (const item of client.echo(inputs())) {
      results.push(item);
    }

    expect(results).toEqual([{ reply: 'echo:hello' }, { reply: 'echo:world' }]);
    await host.stop();
  });

  test('duplex: handler can yield more items than input', async () => {
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    const host = await Host.create(
      EchoService,
      {
        async *echo(inputStream: AsyncIterable<{ msg: string }>) {
          for await (const item of inputStream) {
            yield { reply: `${item.msg}:1` };
            yield { reply: `${item.msg}:2` };
          }
        },
      } as any,
      hostTransport
    );

    const client = Client.create(EchoService, clientTransport);

    async function* inputs() {
      yield { msg: 'a' };
    }

    const results: unknown[] = [];
    for await (const item of client.echo(inputs())) {
      results.push(item);
    }

    expect(results).toEqual([{ reply: 'a:1' }, { reply: 'a:2' }]);
    await host.stop();
  });

  test('duplex: error mid-stream propagates to client', async () => {
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    const host = await Host.create(
      EchoService,
      {
        async *echo(inputStream: AsyncIterable<{ msg: string }>) {
          for await (const item of inputStream) {
            if (item.msg === 'fail') {
              throw { _tag: 'EchoFailed', payload: { msg: item.msg } };
            }
            yield { reply: `echo:${item.msg}` };
          }
        },
      } as any,
      hostTransport
    );

    const client = Client.create(EchoService, clientTransport);

    async function* inputs() {
      yield { msg: 'ok' };
      yield { msg: 'fail' };
    }

    const results: unknown[] = [];
    try {
      for await (const item of client.echo(inputs())) {
        results.push(item);
      }
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err._tag).toBe('EchoFailed');
    }
    expect(results).toEqual([{ reply: 'echo:ok' }]);
    await host.stop();
  });
});

describe('end-to-end: duplex streaming with context', () => {
  const ChatService = Contract.create('chat', {
    version: '1.0.0',
    context: {
      identity: z.object({ userId: z.string() }),
    },
    methods: {
      chat: {
        kind: 'duplex' as const,
        input: z.object({ msg: z.string() }),
        output: z.object({ reply: z.string() }),
      },
    },
  });

  test('duplex with context: context is available in handler', async () => {
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    const host = await Host.create(
      ChatService,
      {
        async *chat(
          ctx: { identity: { userId: string } },
          inputStream: AsyncIterable<{ msg: string }>
        ) {
          for await (const item of inputStream) {
            yield { reply: `${ctx.identity.userId}: ${item.msg}` };
          }
        },
      } as any,
      hostTransport
    );

    const client = Client.create(ChatService, clientTransport);

    async function* inputs() {
      yield { msg: 'hi' };
    }

    const results: unknown[] = [];
    for await (const item of client.chat({ identity: { userId: 'alice' } }, inputs())) {
      results.push(item);
    }

    expect(results).toEqual([{ reply: 'alice: hi' }]);
    await host.stop();
  });
});

describe('end-to-end: mixed unary and streaming methods', () => {
  const MixedService = Contract.create('mixed', {
    version: '1.0.0',
    methods: {
      ping: {
        output: z.object({ pong: z.boolean() }),
      },
      watch: {
        kind: 'serverStream' as const,
        output: z.object({ n: z.number() }),
      },
      collect: {
        kind: 'clientStream' as const,
        input: z.object({ n: z.number() }),
        output: z.object({ sum: z.number() }),
      },
    },
  });

  test('unary and streaming methods coexist on same service', async () => {
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    const host = await Host.create(
      MixedService,
      {
        ping: async () => ({ pong: true }),
        async *watch() {
          yield { n: 1 };
          yield { n: 2 };
        },
        async collect(inputStream: AsyncIterable<{ n: number }>) {
          let sum = 0;
          for await (const item of inputStream) {
            sum += item.n;
          }
          return { sum };
        },
      } as any,
      hostTransport
    );

    const client = Client.create(MixedService, clientTransport);

    const pingResult = await client.ping();
    expect(pingResult).toEqual({ pong: true });

    const streamResults: unknown[] = [];
    for await (const item of client.watch()) {
      streamResults.push(item);
    }
    expect(streamResults).toEqual([{ n: 1 }, { n: 2 }]);

    async function* nums() {
      yield { n: 3 };
      yield { n: 7 };
    }
    const collectResult = await client.collect(nums());
    expect(collectResult).toEqual({ sum: 10 });

    await host.stop();
  });
});

describe('end-to-end: multiple services on one bus', () => {
  const ServiceA = Contract.create('service-a', {
    version: '1.0.0',
    methods: {
      ping: {
        output: z.object({ from: z.string() }),
      },
    },
  });

  const ServiceB = Contract.create('service-b', {
    version: '1.0.0',
    methods: {
      ping: {
        output: z.object({ from: z.string() }),
      },
    },
  });

  test('multiple services coexist on the same bus', async () => {
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();

    const hostA = await Host.create(
      ServiceA,
      { ping: async () => ({ from: 'A' }) } as any,
      hostTransport
    );

    const hostB = await Host.create(
      ServiceB,
      { ping: async () => ({ from: 'B' }) } as any,
      hostTransport
    );

    const clientA = Client.create(ServiceA, clientTransport);
    const clientB = Client.create(ServiceB, clientTransport);

    const resultA = await clientA.ping();
    const resultB = await clientB.ping();

    expect(resultA).toEqual({ from: 'A' });
    expect(resultB).toEqual({ from: 'B' });

    await hostA.stop();
    await hostB.stop();
  });
});
