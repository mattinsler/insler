import { describe, expect, test } from 'bun:test';

import type { ClientTransport } from '@insler/rpc/client';
import type { HostHandler, HostRequest, HostTransport } from '@insler/rpc/host';
import { jsonBytesSerde } from '@insler/serde-json';
import type { Msg, NatsConnection, Subscription } from '@nats-io/transport-node';

import { NatsClientTransport } from './client-transport.js';
import { NatsHostTransport } from './host-transport.js';
import { createNatsTransport } from './index.js';

// --------------------------------------------------------------------------
// Mock NATS infrastructure
// --------------------------------------------------------------------------

interface _MockSubscriptionHandler {
  subject: string;
  queue?: string;
  callback: (msg: MockMsg) => void;
}

interface MockMsg {
  data: Uint8Array;
  respond: (data: Uint8Array) => void;
}

class MockSubscription implements AsyncIterable<MockMsg> {
  private messages: MockMsg[] = [];
  private waiters: ((msg: MockMsg) => void)[] = [];
  private closed = false;

  push(msg: MockMsg): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      this.messages.push(msg);
    }
  }

  unsubscribe(): void {
    this.closed = true;
    // Wake up any waiting consumers so they exit the loop
    for (const waiter of this.waiters) {
      // Signal close by passing a sentinel that we'll handle
      waiter(null as unknown as MockMsg);
    }
    this.waiters = [];
  }

  getSubject(): string {
    return '';
  }

  getReceived(): number {
    return 0;
  }

  getProcessed(): number {
    return 0;
  }

  getID(): number {
    return 0;
  }

  getMax(): number | undefined {
    return undefined;
  }

  isClosed(): boolean {
    return this.closed;
  }

  drain(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  [Symbol.asyncIterator](): AsyncIterator<MockMsg> {
    return {
      next: (): Promise<IteratorResult<MockMsg>> => {
        if (this.closed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        const msg = this.messages.shift();
        if (msg) {
          return Promise.resolve({ done: false, value: msg });
        }
        return new Promise((resolve) => {
          this.waiters.push((m: MockMsg) => {
            if (m === null || this.closed) {
              resolve({ done: true, value: undefined });
            } else {
              resolve({ done: false, value: m });
            }
          });
        });
      },
    };
  }
}

class MockNatsConnection {
  private subscriptions: { subject: string; queue?: string; sub: MockSubscription }[] = [];

  subscribe(subject: string, opts?: { queue?: string }): Subscription {
    const sub = new MockSubscription();
    this.subscriptions.push({ subject, queue: opts?.queue, sub });
    return sub as unknown as Subscription;
  }

  async request(subject: string, data: Uint8Array, opts?: { timeout: number }): Promise<Msg> {
    const match = this.subscriptions.find((s) => s.subject === subject);
    if (!match) {
      const err = new Error(`TIMEOUT: no subscription for ${subject}`);
      err.name = 'NatsError';
      throw err;
    }

    return new Promise<Msg>((resolve, reject) => {
      const timeout = opts?.timeout ?? 5000;
      const timer = setTimeout(() => {
        const err = new Error('TIMEOUT');
        err.name = 'NatsError';
        reject(err);
      }, timeout);

      const msg: MockMsg = {
        data,
        respond: (responseData: Uint8Array) => {
          clearTimeout(timer);
          resolve({ data: responseData } as unknown as Msg);
        },
      };

      match.sub.push(msg);
    });
  }

  getSubscriptions(): { subject: string; queue?: string; sub: MockSubscription }[] {
    return this.subscriptions;
  }

  /**
   * Subscriptions for the application/RPC data plane only, i.e. excluding the
   * ADR-32 discovery control subjects (`$SRV.*`) that `register()` now also
   * stands up. The host adds the control-plane subscriptions before the method
   * subscriptions, so positional `[0]` is no longer the RPC subject — these tests
   * select the RPC subscriptions explicitly.
   */
  getRpcSubscriptions(): { subject: string; queue?: string; sub: MockSubscription }[] {
    return this.subscriptions.filter((s) => !s.subject.startsWith('$SRV.'));
  }
}

function createMockConnection(): MockNatsConnection {
  return new MockNatsConnection();
}

// --------------------------------------------------------------------------
// Transport-level tests
// --------------------------------------------------------------------------

describe('NatsClientTransport', () => {
  test('invoke: encodes request, sends via NATS, decodes response', async () => {
    const conn = createMockConnection();
    const serde = jsonBytesSerde;

    // Set up a mock subscription that echoes back
    const sub = conn.subscribe('rpc.my-service.echo');
    (async () => {
      for await (const msg of sub as unknown as AsyncIterable<MockMsg>) {
        const request = serde.decode(msg.data) as { input?: unknown };
        msg.respond(serde.encode({ output: request.input }));
      }
    })();

    const transport: ClientTransport = new NatsClientTransport({
      connection: conn as unknown as NatsConnection,
      serde,
    });

    const response = await transport.invoke({
      service: 'my-service',
      method: 'echo',
      kind: 'unary',
      input: { message: 'hello' },
    });

    expect(response.output).toEqual({ message: 'hello' });
    expect(response.error).toBeUndefined();

    (sub as unknown as MockSubscription).unsubscribe();
  });

  test('invoke: passes metadata in wire request', async () => {
    const conn = createMockConnection();
    const serde = jsonBytesSerde;

    let receivedMetadata: Record<string, string> | undefined;
    const sub = conn.subscribe('rpc.svc.check');
    (async () => {
      for await (const msg of sub as unknown as AsyncIterable<MockMsg>) {
        const request = serde.decode(msg.data) as {
          input?: unknown;
          metadata?: Record<string, string>;
        };
        receivedMetadata = request.metadata;
        msg.respond(serde.encode({ output: 'ok' }));
      }
    })();

    const transport: ClientTransport = new NatsClientTransport({
      connection: conn as unknown as NatsConnection,
      serde,
    });

    await transport.invoke({
      service: 'svc',
      method: 'check',
      kind: 'unary',
      metadata: { 'x-trace': '123' },
    });

    expect(receivedMetadata).toEqual({ 'x-trace': '123' });

    (sub as unknown as MockSubscription).unsubscribe();
  });

  test('invoke: returns __timeout__ error when NATS request times out', async () => {
    const conn = createMockConnection();

    // No subscription set up -- request will timeout
    // We override request to simulate timeout
    conn.request = async (_subject: string, _data: Uint8Array, _opts?: { timeout: number }) => {
      const err = new Error('TIMEOUT');
      err.name = 'NatsError';
      throw err;
    };

    const transport: ClientTransport = new NatsClientTransport({
      connection: conn as unknown as NatsConnection,
      timeout: 100,
    });

    const response = await transport.invoke({
      service: 'svc',
      method: 'slow',
      kind: 'unary',
    });

    expect(response.error).toBeDefined();
    expect(response.error!._tag).toBe('__timeout__');
    expect(response.error!.message).toBe('Request timed out');
  });

  test('invoke: returns __transport__ error when connection is closed', async () => {
    const conn = createMockConnection();
    conn.request = async () => {
      const err = new Error('CONNECTION_CLOSED');
      err.name = 'NatsError';
      throw err;
    };

    const transport: ClientTransport = new NatsClientTransport({
      connection: conn as unknown as NatsConnection,
    });

    const response = await transport.invoke({
      service: 'svc',
      method: 'test',
      kind: 'unary',
    });

    expect(response.error).toBeDefined();
    expect(response.error!._tag).toBe('__transport__');
    expect(response.error!.message).toBe('NATS connection closed');
  });

  test('invoke: returns __serde__ error when response decode fails', async () => {
    const conn = createMockConnection();

    // Set up subscription that responds with garbage
    const sub = conn.subscribe('rpc.svc.bad');
    (async () => {
      for await (const msg of sub as unknown as AsyncIterable<MockMsg>) {
        msg.respond(new Uint8Array([0xff, 0xfe, 0xfd]));
      }
    })();

    const transport: ClientTransport = new NatsClientTransport({
      connection: conn as unknown as NatsConnection,
    });

    const response = await transport.invoke({
      service: 'svc',
      method: 'bad',
      kind: 'unary',
    });

    expect(response.error).toBeDefined();
    expect(response.error!._tag).toBe('__serde__');
    expect(response.error!.message).toContain('Failed to decode response');

    (sub as unknown as MockSubscription).unsubscribe();
  });

  test('invoke: custom subject prefix', async () => {
    const conn = createMockConnection();
    const serde = jsonBytesSerde;

    const sub = conn.subscribe('custom-prefix.svc.test');
    (async () => {
      for await (const msg of sub as unknown as AsyncIterable<MockMsg>) {
        msg.respond(serde.encode({ output: 'custom' }));
      }
    })();

    const transport: ClientTransport = new NatsClientTransport({
      connection: conn as unknown as NatsConnection,
      serde,
      subjectPrefix: 'custom-prefix',
    });

    const response = await transport.invoke({
      service: 'svc',
      method: 'test',
      kind: 'unary',
    });

    expect(response.output).toBe('custom');

    (sub as unknown as MockSubscription).unsubscribe();
  });
});

describe('NatsHostTransport', () => {
  test('register: subscribes to correct subjects', async () => {
    const conn = createMockConnection();

    const transport: HostTransport = new NatsHostTransport({
      connection: conn as unknown as NatsConnection,
    });

    await transport.register({
      service: 'my-service',
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

    const subjects = conn.getSubscriptions().map((s) => s.subject);
    expect(subjects).toContain('rpc.my-service.alpha');
    expect(subjects).toContain('rpc.my-service.beta');
  });

  test('register: uses queue group when specified', async () => {
    const conn = createMockConnection();

    const transport: HostTransport = new NatsHostTransport({
      connection: conn as unknown as NatsConnection,
      queue: 'workers',
    });

    await transport.register({
      service: 'svc',
      methods: [
        {
          method: 'test',
          kind: 'unary',
          handler: async () => ({ output: 'ok' }),
        },
      ],
    });

    const sub = conn.getRpcSubscriptions()[0]!;
    expect(sub.queue).toBe('workers');
  });

  test('register: custom subject prefix', async () => {
    const conn = createMockConnection();

    const transport: HostTransport = new NatsHostTransport({
      connection: conn as unknown as NatsConnection,
      subjectPrefix: 'my-rpc',
    });

    await transport.register({
      service: 'svc',
      methods: [
        {
          method: 'test',
          kind: 'unary',
          handler: async () => ({ output: 'ok' }),
        },
      ],
    });

    const subjects = conn.getSubscriptions().map((s) => s.subject);
    expect(subjects).toContain('my-rpc.svc.test');
  });

  test('handler invocation: decodes request, calls handler, encodes response', async () => {
    const conn = createMockConnection();
    const serde = jsonBytesSerde;

    let receivedRequest: HostRequest | undefined;
    const handler: HostHandler = async (req) => {
      receivedRequest = req;
      return { output: { echo: req.input } };
    };

    const transport: HostTransport = new NatsHostTransport({
      connection: conn as unknown as NatsConnection,
      serde,
    });

    await transport.register({
      service: 'svc',
      methods: [{ method: 'echo', kind: 'unary', handler }],
    });

    // Simulate an incoming NATS message
    const sub = conn.getRpcSubscriptions()[0]!;
    const requestPayload = serde.encode({
      input: { message: 'hello' },
      metadata: { 'x-trace': 'abc' },
    });

    let responseData: Uint8Array | undefined;
    sub.sub.push({
      data: requestPayload,
      respond: (data: Uint8Array) => {
        responseData = data;
      },
    });

    // Wait for async processing
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(receivedRequest).toBeDefined();
    expect(receivedRequest!.service).toBe('svc');
    expect(receivedRequest!.method).toBe('echo');
    expect(receivedRequest!.kind).toBe('unary');
    expect(receivedRequest!.input).toEqual({ message: 'hello' });
    expect(receivedRequest!.metadata).toEqual({ 'x-trace': 'abc' });

    expect(responseData).toBeDefined();
    const response = serde.decode(responseData!) as {
      output?: unknown;
      error?: unknown;
    };
    expect(response.output).toEqual({ echo: { message: 'hello' } });
  });

  test('handler invocation: returns __serde__ error for bad request data', async () => {
    const conn = createMockConnection();
    const serde = jsonBytesSerde;

    const transport: HostTransport = new NatsHostTransport({
      connection: conn as unknown as NatsConnection,
      serde,
    });

    await transport.register({
      service: 'svc',
      methods: [
        {
          method: 'test',
          kind: 'unary',
          handler: async () => ({ output: 'ok' }),
        },
      ],
    });

    const sub = conn.getRpcSubscriptions()[0]!;
    let responseData: Uint8Array | undefined;
    sub.sub.push({
      data: new Uint8Array([0xff, 0xfe, 0xfd]),
      respond: (data: Uint8Array) => {
        responseData = data;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(responseData).toBeDefined();
    const response = serde.decode(responseData!) as {
      error?: { _tag: string; message?: string };
    };
    expect(response.error).toBeDefined();
    expect(response.error!._tag).toBe('__serde__');
    expect(response.error!.message).toContain('Failed to decode request');
  });

  test('unregister: unsubscribes all subscriptions', async () => {
    const conn = createMockConnection();

    const transport: HostTransport = new NatsHostTransport({
      connection: conn as unknown as NatsConnection,
    });

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

    const subs = conn.getSubscriptions();
    expect(subs.every((s) => !s.sub.isClosed())).toBe(true);

    await unregister();

    expect(subs.every((s) => s.sub.isClosed())).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Round-trip tests
// --------------------------------------------------------------------------

describe('round-trip: client + host via mock NATS', () => {
  test('client request routes to host handler and returns response', async () => {
    const conn = createMockConnection();
    const serde = jsonBytesSerde;

    const hostTransport: HostTransport = new NatsHostTransport({
      connection: conn as unknown as NatsConnection,
      serde,
    });

    const handler: HostHandler = async (req) => ({
      output: { doubled: (req.input as number) * 2 },
    });

    await hostTransport.register({
      service: 'math',
      methods: [{ method: 'double', kind: 'unary', handler }],
    });

    const clientTransport: ClientTransport = new NatsClientTransport({
      connection: conn as unknown as NatsConnection,
      serde,
    });

    const response = await clientTransport.invoke({
      service: 'math',
      method: 'double',
      kind: 'unary',
      input: 21,
    });

    expect(response.output).toEqual({ doubled: 42 });
    expect(response.error).toBeUndefined();
  });

  test('error from handler propagates to client', async () => {
    const conn = createMockConnection();
    const serde = jsonBytesSerde;

    const hostTransport: HostTransport = new NatsHostTransport({
      connection: conn as unknown as NatsConnection,
      serde,
    });

    await hostTransport.register({
      service: 'svc',
      methods: [
        {
          method: 'fail',
          kind: 'unary',
          handler: async () => ({
            error: {
              _tag: 'CustomError',
              payload: { detail: 'something went wrong' },
              message: 'Failure',
            },
          }),
        },
      ],
    });

    const clientTransport: ClientTransport = new NatsClientTransport({
      connection: conn as unknown as NatsConnection,
      serde,
    });

    const response = await clientTransport.invoke({
      service: 'svc',
      method: 'fail',
      kind: 'unary',
    });

    expect(response.error).toBeDefined();
    expect(response.error!._tag).toBe('CustomError');
    expect(response.error!.payload).toEqual({ detail: 'something went wrong' });
    expect(response.error!.message).toBe('Failure');
  });

  test('metadata passes through round-trip', async () => {
    const conn = createMockConnection();
    const serde = jsonBytesSerde;

    let receivedMetadata: Record<string, string> | undefined;

    const hostTransport: HostTransport = new NatsHostTransport({
      connection: conn as unknown as NatsConnection,
      serde,
    });

    await hostTransport.register({
      service: 'svc',
      methods: [
        {
          method: 'check',
          kind: 'unary',
          handler: async (req) => {
            receivedMetadata = req.metadata;
            return { output: 'ok' };
          },
        },
      ],
    });

    const clientTransport: ClientTransport = new NatsClientTransport({
      connection: conn as unknown as NatsConnection,
      serde,
    });

    await clientTransport.invoke({
      service: 'svc',
      method: 'check',
      kind: 'unary',
      metadata: { 'x-request-id': 'req-42', authorization: 'Bearer token' },
    });

    expect(receivedMetadata).toEqual({
      'x-request-id': 'req-42',
      authorization: 'Bearer token',
    });
  });

  test('multiple services on same connection', async () => {
    const conn = createMockConnection();
    const serde = jsonBytesSerde;

    const hostTransport: HostTransport = new NatsHostTransport({
      connection: conn as unknown as NatsConnection,
      serde,
    });

    await hostTransport.register({
      service: 'service-a',
      methods: [
        {
          method: 'ping',
          kind: 'unary',
          handler: async () => ({ output: { from: 'A' } }),
        },
      ],
    });

    await hostTransport.register({
      service: 'service-b',
      methods: [
        {
          method: 'ping',
          kind: 'unary',
          handler: async () => ({ output: { from: 'B' } }),
        },
      ],
    });

    const clientTransport: ClientTransport = new NatsClientTransport({
      connection: conn as unknown as NatsConnection,
      serde,
    });

    const responseA = await clientTransport.invoke({
      service: 'service-a',
      method: 'ping',
      kind: 'unary',
    });

    const responseB = await clientTransport.invoke({
      service: 'service-b',
      method: 'ping',
      kind: 'unary',
    });

    expect(responseA.output).toEqual({ from: 'A' });
    expect(responseB.output).toEqual({ from: 'B' });
  });
});

// --------------------------------------------------------------------------
// createNatsTransport tests
// --------------------------------------------------------------------------

describe('createNatsTransport', () => {
  test('returns client and host transports', () => {
    const conn = createMockConnection();

    const { client, host } = createNatsTransport({
      connection: conn as unknown as NatsConnection,
    });

    expect(client).toBeInstanceOf(NatsClientTransport);
    expect(host).toBeInstanceOf(NatsHostTransport);
  });

  test('round-trip works with convenience function', async () => {
    const conn = createMockConnection();
    const serde = jsonBytesSerde;

    const { client, host } = createNatsTransport({
      connection: conn as unknown as NatsConnection,
      serde,
    });

    await host.register({
      service: 'calculator',
      methods: [
        {
          method: 'add',
          kind: 'unary',
          handler: async (req) => {
            const input = req.input as { a: number; b: number };
            return { output: { result: input.a + input.b } };
          },
        },
      ],
    });

    const response = await client.invoke({
      service: 'calculator',
      method: 'add',
      kind: 'unary',
      input: { a: 3, b: 4 },
    });

    expect(response.output).toEqual({ result: 7 });
  });

  test('passes options through to both transports', async () => {
    const conn = createMockConnection();

    const { host } = createNatsTransport({
      connection: conn as unknown as NatsConnection,
      subjectPrefix: 'custom',
      queue: 'my-queue',
    });

    await host.register({
      service: 'svc',
      methods: [
        {
          method: 'test',
          kind: 'unary',
          handler: async () => ({ output: 'ok' }),
        },
      ],
    });

    const subs = conn.getRpcSubscriptions();
    expect(subs[0]!.subject).toBe('custom.svc.test');
    expect(subs[0]!.queue).toBe('my-queue');
  });
});
