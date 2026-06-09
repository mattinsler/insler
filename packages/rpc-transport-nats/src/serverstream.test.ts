import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { Client } from '@insler/rpc-client';
import type { ClientRequest, ClientResponse, ClientTransport } from '@insler/rpc-client';
import { Contract } from '@insler/rpc-contract';
import { Host } from '@insler/rpc-host';
import type { HostRequest, HostResponse } from '@insler/rpc-host';
import { cborSerde } from '@insler/serde-cbor';
import { jsonBytesSerde } from '@insler/serde-json';
import type { NatsConnection, Subscription, SubscriptionOptions } from '@nats-io/transport-node';
import { z } from 'zod';

import { createNatsTransport, NatsClientTransport, NatsHostTransport } from './index.js';
import { type EphemeralNatsServer, startEphemeralNatsServer } from './nats-test-harness.js';

// --------------------------------------------------------------------------
// serverStream over NATS — happy path (issue 0004, ADR-0001 §2.2-2.4).
//
// Per docs/agents/libraries/rpc-transport-nats.md, wire-format/serde/queue behavior
// is asserted here against a REAL nats-server (the ephemeral harness from issue
// 0001), mirroring transport-memory's observable serverStream result. Each test
// asserts external, observable behavior at the transport boundary: what the
// Client yields, that the open request is queue-grouped with opaque per-call
// inboxes, that outputs round-trip through the configured serde, that
// context/metadata reaches the handler, that it composes with middleware, and
// that both inboxes are torn down on completion (no leaked subscriptions).
// --------------------------------------------------------------------------

let server: EphemeralNatsServer;

beforeAll(async () => {
  server = await startEphemeralNatsServer();
});

afterAll(async () => {
  await server.stop();
});

// The canonical parity contract — same shape transport-memory's serverStream
// suite uses, so the observable result can be compared directly.
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

describe('serverStream over NATS — end-to-end parity with transport-memory', () => {
  test('one request → a stream of outputs → graceful end (mirrors memory)', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });

    const host = await Host.create(
      EventService,
      {
        async *watch(input: { topic: string }) {
          yield { event: `${input.topic}:start`, seq: 1 };
          yield { event: `${input.topic}:data`, seq: 2 };
          yield { event: `${input.topic}:end`, seq: 3 };
        },
      } as never,
      hostTransport
    );

    const client = Client.create(EventService, clientTransport);
    const results: unknown[] = [];
    for await (const item of client.watch({ topic: 'test' })) {
      results.push(item);
    }

    // Same observable result transport-memory produces for this call.
    expect(results).toEqual([
      { event: 'test:start', seq: 1 },
      { event: 'test:data', seq: 2 },
      { event: 'test:end', seq: 3 },
    ]);

    await host.stop();
    await connection.close();
  });

  test('empty stream yields nothing (graceful end with no DataFrames)', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });

    const host = await Host.create(
      EventService,
      {
        async *watch() {
          // yield nothing — the host sends only the terminal EndFrame
        },
      } as never,
      hostTransport
    );

    const client = Client.create(EventService, clientTransport);
    const results: unknown[] = [];
    for await (const item of client.watch({ topic: 'empty' })) {
      results.push(item);
    }

    expect(results).toEqual([]);

    await host.stop();
    await connection.close();
  });
});

describe('serverStream over NATS — open handshake (queue group + per-call inboxes)', () => {
  test('the opening request is queue-grouped (default `q`)', async () => {
    // Capture the queue group used for the method (RPC) subscription by spying on
    // subscribe. The open request rides the queue-grouped method subject so it
    // load-balances to one instance.
    const connection = await server.connect();
    const queues: Array<{ subject: string; queue?: string }> = [];
    const realSubscribe = connection.subscribe.bind(connection);
    connection.subscribe = ((subject: string, opts?: SubscriptionOptions): Subscription => {
      queues.push({ subject, queue: opts?.queue });
      return realSubscribe(subject, opts);
    }) as NatsConnection['subscribe'];

    const host = new NatsHostTransport({ connection });
    const unregister = await host.register({
      service: 'events',
      methods: [
        {
          method: 'watch',
          kind: 'serverStream',
          handler: async function* () {
            yield { output: { event: 'x', seq: 1 } };
          },
        },
      ],
    });

    const methodSub = queues.find((q) => q.subject === 'rpc.events.watch');
    expect(methodSub).toBeDefined();
    expect(methodSub!.queue).toBe('q');

    await unregister();
    await connection.close();
  });

  test('`up`/`down` are per-call, opaque inboxes carried on the OpenRequest', async () => {
    // Inspect the OpenRequest envelope the client publishes on the method subject.
    const connection = await server.connect();
    const serde = jsonBytesSerde;

    const opens: Array<{ up?: unknown; down?: unknown; input?: unknown }> = [];
    const sub = connection.subscribe('rpc.events.watch', { queue: 'q' });
    void (async () => {
      for await (const msg of sub) {
        const open = serde.decode(msg.data) as { up?: string; down?: string; input?: unknown };
        opens.push(open);
        // Send a single terminal EndFrame on `down` so the client completes.
        if (open.down) {
          connection.publish(open.down, serde.encode({ t: 'e', seq: 0 }));
        }
      }
    })();

    const clientTransport = new NatsClientTransport({ connection });
    const stream = clientTransport.invokeServerStream!({
      service: 'events',
      method: 'watch',
      kind: 'serverStream',
      input: { topic: 'inbox-probe' },
    });
    for await (const _ of stream) {
      // drain (no DataFrames; completes on EndFrame)
    }

    expect(opens).toHaveLength(1);
    const open = opens[0]!;
    // The single request rides `input`.
    expect(open.input).toEqual({ topic: 'inbox-probe' });
    // Two distinct, non-empty, opaque inboxes — and NOT the method subject.
    expect(typeof open.up).toBe('string');
    expect(typeof open.down).toBe('string');
    expect(open.up).not.toBe(open.down);
    expect(open.up as string).not.toBe('rpc.events.watch');
    expect((open.up as string).length).toBeGreaterThan(0);
    expect((open.down as string).length).toBeGreaterThan(0);

    sub.unsubscribe();
    await connection.close();
  });
});

describe('serverStream over NATS — serde round-trip', () => {
  test('output items round-trip through a NON-JSON serde (CBOR)', async () => {
    const connection = await server.connect();
    // CBOR is a binary, non-JSON serde — proves frames ride the injected encoder.
    const { client: clientTransport, host: hostTransport } = createNatsTransport({
      connection,
      serde: cborSerde,
    });

    const host = await Host.create(
      EventService,
      {
        async *watch(input: { topic: string }) {
          yield { event: `${input.topic}:a`, seq: 10 };
          yield { event: `${input.topic}:b`, seq: 20 };
        },
      } as never,
      hostTransport
    );

    const client = Client.create(EventService, clientTransport);
    const results: unknown[] = [];
    for await (const item of client.watch({ topic: 'cbor' })) {
      results.push(item);
    }

    expect(results).toEqual([
      { event: 'cbor:a', seq: 10 },
      { event: 'cbor:b', seq: 20 },
    ]);

    await host.stop();
    await connection.close();
  });
});

describe('serverStream over NATS — context/metadata propagation', () => {
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

  test('context on the open request reaches the handler (parity with unary)', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });

    const host = await Host.create(
      ContextStreamService,
      {
        async *watchForUser(ctx: { identity: { userId: string } }) {
          yield { msg: `hello ${ctx.identity.userId}` };
        },
      } as never,
      hostTransport
    );

    const client = Client.create(ContextStreamService, clientTransport);
    const results: unknown[] = [];
    for await (const item of client.watchForUser({ identity: { userId: 'alice' } })) {
      results.push(item);
    }

    expect(results).toEqual([{ msg: 'hello alice' }]);

    await host.stop();
    await connection.close();
  });

  test('raw metadata on the OpenRequest is delivered to the host handler', async () => {
    // Transport-level: the metadata field on the open request reaches the
    // HostRequest the host hands the serverStream handler (the unary propagation
    // path, reused for streaming).
    const connection = await server.connect();
    let received: Record<string, string> | undefined;

    const host = new NatsHostTransport({ connection });
    const unregister = await host.register({
      service: 'events',
      methods: [
        {
          method: 'watch',
          kind: 'serverStream',
          handler: async function* (req: HostRequest): AsyncIterable<HostResponse> {
            received = req.metadata;
            yield { output: { event: 'ok', seq: 1 } };
          },
        },
      ],
    });

    const clientTransport = new NatsClientTransport({ connection });
    const stream = clientTransport.invokeServerStream!({
      service: 'events',
      method: 'watch',
      kind: 'serverStream',
      input: { topic: 't' },
      metadata: { 'x-trace': 'trace-123', authorization: 'Bearer tok' },
    });
    for await (const _ of stream) {
      // drain
    }

    expect(received).toEqual({ 'x-trace': 'trace-123', authorization: 'Bearer tok' });

    await unregister();
    await connection.close();
  });
});

describe('serverStream over NATS — middleware composition', () => {
  test('composes with a client middleware and a host middleware (transport seam)', async () => {
    // The transport faithfully carries whatever request the client wraps and
    // whatever handler the host wraps. We compose middleware at the transport
    // seam — a client-side wrapper mutates the ClientRequest before
    // invokeServerStream; a host-side wrapper observes/annotates the HostRequest
    // around the registered serverStream handler — exactly as unary middleware
    // wraps invoke/handler.
    const connection = await server.connect();

    const clientSeen: ClientRequest[] = [];
    const hostSeen: HostRequest[] = [];

    // Host middleware: wraps the registered serverStream handler.
    const baseHandler = async function* (req: HostRequest): AsyncIterable<HostResponse> {
      hostSeen.push(req);
      yield { output: { event: req.metadata?.['x-from-client'] ?? 'none', seq: 1 } };
    };
    const hostMiddleware =
      (
        inner: (req: HostRequest) => AsyncIterable<HostResponse>
      ): ((req: HostRequest) => AsyncIterable<HostResponse>) =>
      (req: HostRequest) =>
        inner({ ...req, metadata: { ...req.metadata, 'x-host-mw': 'seen' } });

    const host = new NatsHostTransport({ connection });
    const unregister = await host.register({
      service: 'events',
      methods: [{ method: 'watch', kind: 'serverStream', handler: hostMiddleware(baseHandler) }],
    });

    // Client middleware: wraps invokeServerStream.
    const baseTransport = new NatsClientTransport({ connection });
    const clientMiddleware = (
      req: ClientRequest,
      next: (r: ClientRequest) => AsyncIterable<ClientResponse>
    ): AsyncIterable<ClientResponse> => {
      clientSeen.push(req);
      return next({ ...req, metadata: { ...req.metadata, 'x-from-client': 'client-mw' } });
    };
    const wrappedTransport: ClientTransport = {
      invoke: (r) => baseTransport.invoke(r),
      invokeServerStream: (r) => clientMiddleware(r, (rr) => baseTransport.invokeServerStream!(rr)),
    };

    const stream = wrappedTransport.invokeServerStream!({
      service: 'events',
      method: 'watch',
      kind: 'serverStream',
      input: { topic: 't' },
    });
    const outputs: unknown[] = [];
    for await (const item of stream) {
      outputs.push(item.output);
    }

    // Client middleware ran (saw the request) and its mutation reached the host.
    expect(clientSeen).toHaveLength(1);
    expect(hostSeen).toHaveLength(1);
    expect(hostSeen[0]!.metadata?.['x-from-client']).toBe('client-mw');
    // Host middleware ran (its annotation is visible to the inner handler).
    expect(hostSeen[0]!.metadata?.['x-host-mw']).toBe('seen');
    // The output carried the client-mutated metadata back out — full round-trip.
    expect(outputs).toEqual([{ event: 'client-mw', seq: 1 }]);

    await unregister();
    await connection.close();
  });
});

describe('serverStream over NATS — subscription teardown (no leaks)', () => {
  test('both inboxes are unsubscribed on normal completion', async () => {
    // Track live (subscribed but not yet unsubscribed) subscriptions per subject
    // on a single connection shared by client and host, so we can assert the
    // per-call `up`/`down` inbox subscriptions are gone after the stream ends.
    const connection = await server.connect();
    const live = new Map<string, number>();
    const realSubscribe = connection.subscribe.bind(connection);
    connection.subscribe = ((subject: string, opts?: SubscriptionOptions): Subscription => {
      const sub = realSubscribe(subject, opts);
      live.set(subject, (live.get(subject) ?? 0) + 1);
      const realUnsub = sub.unsubscribe.bind(sub);
      sub.unsubscribe = ((max?: number): void => {
        live.set(subject, (live.get(subject) ?? 1) - 1);
        return realUnsub(max);
      }) as Subscription['unsubscribe'];
      return sub;
    }) as NatsConnection['subscribe'];

    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });

    const host = await Host.create(
      EventService,
      {
        async *watch(input: { topic: string }) {
          yield { event: `${input.topic}:1`, seq: 1 };
          yield { event: `${input.topic}:2`, seq: 2 };
        },
      } as never,
      hostTransport
    );

    // Subjects subscribed BEFORE the call (method subject + discovery control
    // subjects). The per-call inboxes are everything added during the call.
    const beforeSubjects = new Set(live.keys());

    const client = Client.create(EventService, clientTransport);
    const results: unknown[] = [];
    for await (const item of client.watch({ topic: 'leak' })) {
      results.push(item);
    }
    expect(results).toHaveLength(2);

    // Allow teardown microtasks/publishes to settle.
    await connection.flush();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Every per-call inbox subscription (both `up` and `down`) created during the
    // call must be back to zero live subscriptions — no leaks.
    const perCallSubjects = [...live.keys()].filter((s) => !beforeSubjects.has(s));
    // There must have been at least the two per-call inboxes.
    expect(perCallSubjects.length).toBeGreaterThanOrEqual(2);
    for (const subject of perCallSubjects) {
      expect(live.get(subject)).toBe(0);
    }

    await host.stop();
    await connection.close();
  });
});
