import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { Client, ContractError } from '@insler/rpc-client';
import type { ClientRequest, ClientResponse, ClientTransport } from '@insler/rpc-client';
import { Contract } from '@insler/rpc-contract';
import { Host } from '@insler/rpc-host';
import type { HostRequest, HostResponse } from '@insler/rpc-host';
import { createMemoryTransport } from '@insler/rpc-transport-memory';
import { cborSerde } from '@insler/serde-cbor';
import { jsonBytesSerde } from '@insler/serde-json';
import type { NatsConnection, Subscription, SubscriptionOptions } from '@nats-io/transport-node';
import { z } from 'zod';

import { createNatsTransport, NatsClientTransport, NatsHostTransport } from './index.js';
import type { Frame } from './index.js';
import { type EphemeralNatsServer, startEphemeralNatsServer } from './nats-test-harness.js';

// --------------------------------------------------------------------------
// clientStream over NATS (issue 0007, ADR-0001 §2.2-2.6).
//
// The mirror of serverStream, metering the OTHER direction. The client streams
// input `DataFrame`s on `up`, then half-closes `up` with one `EndFrame`; the host
// runs the registered clientStream handler over the inbound input `AsyncIterable`,
// then publishes its single output `DataFrame` followed by an `EndFrame` on
// `down`. Call completion is the `down` `EndFrame`.
//
// Backpressure meters `up`: the HOST is the receiver and grants credit (its first
// `CreditFrame` on `down`, replenished as it consumes inputs). Reuses the same
// 0004-0006 machinery (open handshake, CreditController/grantOnConsume, error/fault
// mapping). Assertions are at the transport boundary (what the Client returns /
// which `__*__` tag), mirroring transport-memory's observable clientStream result.
// --------------------------------------------------------------------------

let server: EphemeralNatsServer;

beforeAll(async () => {
  server = await startEphemeralNatsServer();
});

afterAll(async () => {
  await server.stop();
});

// The canonical parity contract — same shape transport-memory's clientStream suite
// uses (the `AggregateService.sum` case), so the observable result compares
// directly.
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

const sumHandlers = {
  async sum(inputStream: AsyncIterable<{ value: number }>) {
    let total = 0;
    for await (const item of inputStream) {
      total += item.value;
    }
    return { total };
  },
} as never;

/**
 * Track a connection's `subscribe`/`unsubscribe` so a test can assert per-call
 * inboxes are torn down. Returns a `live` map of subject -> live count.
 */
function trackSubscriptions(connection: NatsConnection): Map<string, number> {
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
  return live;
}

describe('clientStream over NATS — end-to-end parity with transport-memory', () => {
  test('input stream → one aggregated response (mirrors memory)', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });

    const host = await Host.create(AggregateService, sumHandlers, hostTransport);

    const client = Client.create(AggregateService, clientTransport);

    async function* values() {
      yield { value: 10 };
      yield { value: 20 };
      yield { value: 30 };
    }

    const result = await client.sum(values());
    // Same observable result transport-memory produces for this call.
    expect(result).toEqual({ total: 60 });

    await host.stop();
    await connection.close();
  });

  test('result mode returns the ok wrapper (mirrors memory)', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });

    const host = await Host.create(AggregateService, sumHandlers, hostTransport);
    const client = Client.create(AggregateService, clientTransport, { errors: 'result' });

    async function* values() {
      yield { value: 5 };
      yield { value: 15 };
    }

    const result = await client.sum(values());
    expect(result).toEqual({ ok: true, value: { total: 20 } });

    await host.stop();
    await connection.close();
  });

  test('empty input stream → host responds over an immediately half-closed up', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });

    const host = await Host.create(AggregateService, sumHandlers, hostTransport);
    const client = Client.create(AggregateService, clientTransport);

    async function* values(): AsyncIterable<{ value: number }> {
      // yield nothing — the client sends only the terminal EndFrame on `up`
    }

    const result = await client.sum(values());
    expect(result).toEqual({ total: 0 });

    await host.stop();
    await connection.close();
  });

  test('observable result matches transport-memory for the same call', async () => {
    async function* values() {
      yield { value: 1 };
      yield { value: 2 };
      yield { value: 3 };
      yield { value: 4 };
    }

    // transport-memory: the canonical observable result.
    const memoryTransport = createMemoryTransport();
    const memoryHost = await Host.create(AggregateService, sumHandlers, memoryTransport.host);
    const memoryClient = Client.create(AggregateService, memoryTransport.client);
    const memoryResult = await memoryClient.sum(values());
    await memoryHost.stop();

    // NATS: the same call, same handler.
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });
    const natsHost = await Host.create(AggregateService, sumHandlers, hostTransport);
    const natsClient = Client.create(AggregateService, clientTransport);
    const natsResult = await natsClient.sum(values());
    await natsHost.stop();
    await connection.close();

    expect(natsResult).toEqual(memoryResult);
    expect(natsResult).toEqual({ total: 10 });
  });
});

describe('clientStream over NATS — half-close & host single response (wire shape)', () => {
  test('client streams input DataFrames then ONE EndFrame on up; host replies one DataFrame then EndFrame on down', async () => {
    const connection = await server.connect();
    const serde = jsonBytesSerde;

    // A raw "host": for each OpenRequest, subscribe `up`, record the frames the
    // client publishes there, and once the client half-closes (`EndFrame` on up)
    // reply on `down` with one output DataFrame then an EndFrame.
    const upFrames: Frame[] = [];
    const sub = connection.subscribe('rpc.aggregate.sum', { queue: 'q' });
    void (async () => {
      for await (const msg of sub) {
        const open = serde.decode(msg.data) as { up: string; down: string };
        const upSub = connection.subscribe(open.up);
        // Grant the client its initial `up` window (also the "ready on up" signal).
        connection.publish(open.down, serde.encode({ t: 'c', n: 1024 }));
        void (async () => {
          for await (const upMsg of upSub) {
            const frame = serde.decode(upMsg.data) as Frame;
            upFrames.push(frame);
            if (frame.t === 'e') {
              // Host's single output DataFrame then the terminal EndFrame on down.
              connection.publish(open.down, serde.encode({ t: 'd', seq: 0, data: { total: 99 } }));
              connection.publish(open.down, serde.encode({ t: 'e', seq: 1 }));
              upSub.unsubscribe();
              return;
            }
          }
        })();
      }
    })();

    const clientTransport = new NatsClientTransport({ connection });
    const client = Client.create(AggregateService, clientTransport);

    async function* values() {
      yield { value: 7 };
      yield { value: 8 };
    }

    const result = await client.sum(values());
    expect(result).toEqual({ total: 99 });

    // The client published its inputs as DataFrames then exactly one EndFrame
    // (half-close on `up`), in order, with a monotonic seq from 0.
    const dataFrames = upFrames.filter((f): f is Extract<Frame, { t: 'd' }> => f.t === 'd');
    const endFrames = upFrames.filter((f) => f.t === 'e');
    expect(dataFrames.map((f) => f.data)).toEqual([{ value: 7 }, { value: 8 }]);
    expect(dataFrames.map((f) => f.seq)).toEqual([0, 1]);
    expect(endFrames).toHaveLength(1);
    // The EndFrame is the LAST frame on `up` (half-close after all DataFrames).
    expect(upFrames[upFrames.length - 1]!.t).toBe('e');

    sub.unsubscribe();
    await connection.close();
  });

  test('the opening request is queue-grouped (default `q`) with opaque per-call inboxes', async () => {
    const connection = await server.connect();
    const queues: Array<{ subject: string; queue?: string }> = [];
    const realSubscribe = connection.subscribe.bind(connection);
    connection.subscribe = ((subject: string, opts?: SubscriptionOptions): Subscription => {
      queues.push({ subject, queue: opts?.queue });
      return realSubscribe(subject, opts);
    }) as NatsConnection['subscribe'];

    const host = new NatsHostTransport({ connection });
    const unregister = await host.register({
      service: 'aggregate',
      methods: [
        {
          method: 'sum',
          kind: 'clientStream',
          handler: async () => ({ output: { total: 0 } }),
        },
      ],
    });

    const methodSub = queues.find((q) => q.subject === 'rpc.aggregate.sum');
    expect(methodSub).toBeDefined();
    expect(methodSub!.queue).toBe('q');

    await unregister();
    await connection.close();
  });
});

describe('clientStream over NATS — serde round-trip', () => {
  test('input items and the output round-trip through a NON-JSON serde (CBOR)', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({
      connection,
      serde: cborSerde,
    });

    const host = await Host.create(AggregateService, sumHandlers, hostTransport);
    const client = Client.create(AggregateService, clientTransport);

    async function* values() {
      yield { value: 100 };
      yield { value: 200 };
    }

    const result = await client.sum(values());
    expect(result).toEqual({ total: 300 });

    await host.stop();
    await connection.close();
  });
});

describe('clientStream over NATS — context/metadata propagation', () => {
  const ContextAggregate = Contract.create('ctx-aggregate', {
    version: '1.0.0',
    context: {
      identity: z.object({ userId: z.string() }),
    },
    methods: {
      sumForUser: {
        kind: 'clientStream' as const,
        input: z.object({ value: z.number() }),
        output: z.object({ total: z.number(), user: z.string() }),
      },
    },
  });

  test('context on the open request reaches the handler (parity with unary)', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });

    const host = await Host.create(
      ContextAggregate,
      {
        async sumForUser(
          ctx: { identity: { userId: string } },
          inputStream: AsyncIterable<{ value: number }>
        ) {
          let total = 0;
          for await (const item of inputStream) {
            total += item.value;
          }
          return { total, user: ctx.identity.userId };
        },
      } as never,
      hostTransport
    );

    const client = Client.create(ContextAggregate, clientTransport);

    async function* values() {
      yield { value: 1 };
      yield { value: 2 };
    }

    const result = await client.sumForUser({ identity: { userId: 'alice' } }, values());
    expect(result).toEqual({ total: 3, user: 'alice' });

    await host.stop();
    await connection.close();
  });
});

describe('clientStream over NATS — backpressure on up (host grants credit)', () => {
  const TICKS = 20;
  const CREDIT = 3;

  test('a slow host consumer bounds client-produced-but-unconsumed input DataFrames to the credit window', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({
      connection,
      // Small window so the bound is observable. This is the `up` window the HOST
      // grants the client.
      credit: CREDIT,
    });

    // The host consumes inputs SLOWLY. With backpressure wired, the client cannot
    // run arbitrarily far ahead: its production on `up` is gated by the credit the
    // host grants as it consumes. The handler records how many it has consumed.
    let consumed = 0;
    const ClientPushService = Contract.create('pusher', {
      version: '1.0.0',
      methods: {
        push: {
          kind: 'clientStream' as const,
          input: z.object({ n: z.number() }),
          output: z.object({ count: z.number() }),
        },
      },
    });

    const host = await Host.create(
      ClientPushService,
      {
        async push(inputStream: AsyncIterable<{ n: number }>) {
          for await (const _item of inputStream) {
            consumed += 1;
            // Slow consumer: pause on every item so the client would race ahead
            // without backpressure.
            await new Promise((r) => setTimeout(r, 15));
          }
          return { count: consumed };
        },
      } as never,
      hostTransport
    );

    const client = Client.create(ClientPushService, clientTransport);

    // The fast producer records how many it has PRODUCED (handed to the transport)
    // and observes the in-flight gap against what the host has consumed.
    let produced = 0;
    let maxInFlight = 0;
    async function* fastProducer() {
      for (let n = 0; n < TICKS; n++) {
        produced = n + 1;
        const inFlight = produced - consumed;
        maxInFlight = Math.max(maxInFlight, inFlight);
        yield { n };
      }
    }

    const result = await client.push(fastProducer());
    expect(result).toEqual({ count: TICKS });

    // The client produced exactly the stream length (it ran to completion)...
    expect(produced).toBe(TICKS);
    // ...but never ran more than ~one window ahead of the host's consumption.
    // Without flow control, produced would jump to TICKS almost immediately and
    // maxInFlight would approach TICKS. A small constant bound proves the client
    // paused at credit 0 and resumed only as the host consumed (granting credit).
    expect(maxInFlight).toBeLessThanOrEqual(CREDIT + 1);

    await host.stop();
    await connection.close();
  });

  test('the sender resumes after pausing — an input stream longer than the window completes', async () => {
    // If credit were never replenished, the client would pause permanently after
    // the first `credit` DataFrames and the call would hang. Completing an input
    // stream many times longer than the window proves resume-on-CreditFrame.
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({
      connection,
      credit: 2,
    });

    const host = await Host.create(AggregateService, sumHandlers, hostTransport);
    const client = Client.create(AggregateService, clientTransport);

    async function* values() {
      for (let n = 0; n < 50; n++) {
        yield { value: 1 };
      }
    }

    const result = await client.sum(values());
    expect(result).toEqual({ total: 50 });

    await host.stop();
    await connection.close();
  });
});

describe('clientStream over NATS — mid-stream error & fault mapping', () => {
  // A clientStream contract method with a DECLARED error, so the host wrapper
  // serializes the thrown `{ _tag, payload }` verbatim into the ErrorFrame.
  const FailingAggregate = Contract.create('aggregate', {
    version: '1.0.0',
    methods: {
      sum: {
        kind: 'clientStream' as const,
        input: z.object({ value: z.number() }),
        output: z.object({ total: z.number() }),
        errors: {
          TooBig: z.object({ limit: z.number() }),
        },
      },
    },
  });

  test('declared contract error → that typed error (throw mode)', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });

    const host = await Host.create(
      FailingAggregate,
      {
        async sum(inputStream: AsyncIterable<{ value: number }>) {
          let total = 0;
          for await (const item of inputStream) {
            total += item.value;
            if (total > 50) {
              throw { _tag: 'TooBig', payload: { limit: 50 } };
            }
          }
          return { total };
        },
      } as never,
      hostTransport
    );

    const client = Client.create(FailingAggregate, clientTransport);

    async function* values() {
      yield { value: 40 };
      yield { value: 40 };
      yield { value: 40 };
    }

    let caught: ContractError | undefined;
    try {
      await client.sum(values());
      expect.unreachable();
    } catch (err) {
      caught = err as ContractError;
    }

    expect(caught).toBeInstanceOf(ContractError);
    expect(caught!._tag).toBe('TooBig');
    expect(caught!.payload).toEqual({ limit: 50 });

    await host.stop();
    await connection.close();
  });

  test('declared contract error → { ok: false, error } (result mode)', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });

    const host = await Host.create(
      FailingAggregate,
      {
        async sum(inputStream: AsyncIterable<{ value: number }>) {
          let total = 0;
          for await (const item of inputStream) {
            total += item.value;
            if (total > 50) {
              throw { _tag: 'TooBig', payload: { limit: 50 } };
            }
          }
          return { total };
        },
      } as never,
      hostTransport
    );

    const client = Client.create(FailingAggregate, clientTransport, { errors: 'result' });

    async function* values() {
      yield { value: 60 };
    }

    const result = (await client.sum(values())) as { ok: boolean; error?: { _tag: string } };
    expect(result.ok).toBe(false);
    expect(result.error!._tag).toBe('TooBig');

    await host.stop();
    await connection.close();
  });

  test('undeclared host throw collapses to __unknown__ (never leaks internals)', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });

    const host = await Host.create(
      AggregateService,
      {
        async sum(inputStream: AsyncIterable<{ value: number }>) {
          for await (const _item of inputStream) {
            const boom = new Error('internal failure') as Error & { internalDetail?: unknown };
            boom.internalDetail = { dbPassword: 'super-secret-9000' };
            throw boom;
          }
          return { total: 0 };
        },
      } as never,
      hostTransport
    );

    const client = Client.create(AggregateService, clientTransport);

    async function* values() {
      yield { value: 1 };
    }

    let caught: ContractError | undefined;
    try {
      await client.sum(values());
      expect.unreachable();
    } catch (err) {
      caught = err as ContractError;
    }

    expect(caught).toBeInstanceOf(ContractError);
    expect(caught!._tag).toBe('__unknown__');
    expect(caught!.payload).toBeUndefined();
    expect(JSON.stringify(caught ?? '')).not.toContain('super-secret-9000');

    await host.stop();
    await connection.close();
  });

  test('input validation rejects bad items → __validation__ (mirrors memory)', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });

    const host = await Host.create(AggregateService, sumHandlers, hostTransport);
    const client = Client.create(AggregateService, clientTransport);

    async function* badValues() {
      yield { value: 10 };
      yield { bad: 'not a number' } as never;
    }

    let caught: ContractError | undefined;
    try {
      await client.sum(badValues());
      expect.unreachable();
    } catch (err) {
      caught = err as ContractError;
    }

    expect(caught).toBeInstanceOf(ContractError);
    expect(caught!._tag).toBe('__validation__');

    await host.stop();
    await connection.close();
  });

  test('a down frame that fails to decode surfaces as __serde__', async () => {
    const connection = await server.connect();
    const serde = jsonBytesSerde;

    // A raw "host": once the client half-closes `up`, publish a CORRUPT frame on
    // `down`. The client (jsonBytesSerde) fails to decode it -> __serde__.
    const sub = connection.subscribe('rpc.aggregate.sum', { queue: 'q' });
    void (async () => {
      for await (const msg of sub) {
        const open = serde.decode(msg.data) as { up: string; down: string };
        const upSub = connection.subscribe(open.up);
        connection.publish(open.down, serde.encode({ t: 'c', n: 1024 }));
        void (async () => {
          for await (const upMsg of upSub) {
            const frame = serde.decode(upMsg.data) as Frame;
            if (frame.t === 'e') {
              connection.publish(open.down, new Uint8Array([0xff, 0xfe, 0xfd, 0x00, 0x01]));
              upSub.unsubscribe();
              return;
            }
          }
        })();
      }
    })();

    const clientTransport = new NatsClientTransport({ connection });
    const client = Client.create(AggregateService, clientTransport);

    async function* values() {
      yield { value: 1 };
    }

    let caught: ContractError | undefined;
    try {
      await client.sum(values());
      expect.unreachable();
    } catch (err) {
      caught = err as ContractError;
    }

    expect(caught).toBeInstanceOf(ContractError);
    expect(caught!._tag).toBe('__serde__');

    sub.unsubscribe();
    await connection.close();
  });

  test('an early close (down ends with no terminal frame) surfaces as __transport__', async () => {
    const connection = await server.connect();
    const serde = jsonBytesSerde;

    // A raw "host": consume `up`, but never send a terminal frame on `down`. We
    // close the client's connection to force the early-close path deterministically.
    const sub = connection.subscribe('rpc.aggregate.sum', { queue: 'q' });
    void (async () => {
      for await (const msg of sub) {
        const open = serde.decode(msg.data) as { up: string; down: string };
        const upSub = connection.subscribe(open.up);
        connection.publish(open.down, serde.encode({ t: 'c', n: 1024 }));
        void (async () => {
          for await (const upMsg of upSub) {
            const frame = serde.decode(upMsg.data) as Frame;
            if (frame.t === 'e') {
              upSub.unsubscribe();
              return;
            }
          }
        })();
      }
    })();

    const clientConnection = await server.connect();
    const clientTransport = new NatsClientTransport({ connection: clientConnection });
    const client = Client.create(AggregateService, clientTransport);

    async function* values() {
      yield { value: 1 };
    }

    // Race the call against closing the connection mid-flight to force the fault.
    const callPromise = client.sum(values());
    await new Promise((r) => setTimeout(r, 50));
    await clientConnection.close();

    let caught: ContractError | undefined;
    try {
      await callPromise;
      expect.unreachable();
    } catch (err) {
      caught = err as ContractError;
    }

    expect(caught).toBeInstanceOf(ContractError);
    expect(caught!._tag).toBe('__transport__');

    sub.unsubscribe();
    await connection.close();
  });
});

describe('clientStream over NATS — middleware composition (transport seam)', () => {
  test('composes with a client middleware and a host middleware', async () => {
    // End-to-end streaming middleware is not threaded by Client.create/Host.create
    // (a client/host gap, out of scope per the PRD), so we compose middleware at
    // the transport seam: a client-side wrapper mutates the ClientRequest before
    // invokeClientStream; a host-side wrapper observes/annotates the HostRequest
    // around the registered clientStream handler — exactly as issue 0004 did.
    const connection = await server.connect();

    const clientSeen: ClientRequest[] = [];
    const hostSeen: HostRequest[] = [];

    // Host middleware wraps the registered clientStream handler.
    const baseHandler = async (
      req: HostRequest,
      inputStream: AsyncIterable<unknown>
    ): Promise<HostResponse> => {
      hostSeen.push(req);
      let total = 0;
      for await (const item of inputStream) {
        total += (item as { value: number }).value;
      }
      return { output: { total, from: req.metadata?.['x-from-client'] ?? 'none' } };
    };
    const hostMiddleware =
      (
        inner: (req: HostRequest, s: AsyncIterable<unknown>) => Promise<HostResponse>
      ): ((req: HostRequest, s: AsyncIterable<unknown>) => Promise<HostResponse>) =>
      (req, s) =>
        inner({ ...req, metadata: { ...req.metadata, 'x-host-mw': 'seen' } }, s);

    const host = new NatsHostTransport({ connection });
    const unregister = await host.register({
      service: 'aggregate',
      methods: [{ method: 'sum', kind: 'clientStream', handler: hostMiddleware(baseHandler) }],
    });

    // Client middleware wraps invokeClientStream.
    const baseTransport = new NatsClientTransport({ connection });
    const clientMiddleware = (
      req: ClientRequest,
      inputStream: AsyncIterable<unknown>,
      next: (r: ClientRequest, s: AsyncIterable<unknown>) => Promise<ClientResponse>
    ): Promise<ClientResponse> => {
      clientSeen.push(req);
      return next(
        { ...req, metadata: { ...req.metadata, 'x-from-client': 'client-mw' } },
        inputStream
      );
    };
    const wrappedTransport: ClientTransport = {
      invoke: (r) => baseTransport.invoke(r),
      invokeClientStream: (r, s) =>
        clientMiddleware(r, s, (rr, ss) => baseTransport.invokeClientStream!(rr, ss)),
    };

    async function* values() {
      yield { value: 3 };
      yield { value: 4 };
    }

    const response = await wrappedTransport.invokeClientStream!(
      {
        service: 'aggregate',
        method: 'sum',
        kind: 'clientStream',
      },
      values()
    );

    // Client middleware ran and its mutation reached the host.
    expect(clientSeen).toHaveLength(1);
    expect(hostSeen).toHaveLength(1);
    expect(hostSeen[0]!.metadata?.['x-from-client']).toBe('client-mw');
    // Host middleware ran (its annotation is visible to the inner handler).
    expect(hostSeen[0]!.metadata?.['x-host-mw']).toBe('seen');
    // The output carried the client-mutated metadata back out — full round-trip.
    expect(response.output).toEqual({ total: 7, from: 'client-mw' });

    await unregister();
    await connection.close();
  });
});

describe('clientStream over NATS — subscription teardown (no leaks)', () => {
  test('both inboxes are unsubscribed on normal completion', async () => {
    const connection = await server.connect();
    const live = trackSubscriptions(connection);

    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });
    const host = await Host.create(AggregateService, sumHandlers, hostTransport);

    const beforeSubjects = new Set(live.keys());

    const client = Client.create(AggregateService, clientTransport);
    async function* values() {
      yield { value: 1 };
      yield { value: 2 };
    }
    const result = await client.sum(values());
    expect(result).toEqual({ total: 3 });

    // Allow teardown microtasks/publishes to settle.
    await connection.flush();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Every per-call inbox subscription (both `up` and `down`) created during the
    // call must be back to zero live subscriptions — no leaks.
    const perCallSubjects = [...live.keys()].filter((s) => !beforeSubjects.has(s));
    expect(perCallSubjects.length).toBeGreaterThanOrEqual(2);
    for (const subject of perCallSubjects) {
      expect(live.get(subject)).toBe(0);
    }

    await host.stop();
    await connection.close();
  });

  test('on a terminal ErrorFrame, both directions stop and both inboxes unsubscribe', async () => {
    const connection = await server.connect();
    const live = trackSubscriptions(connection);

    const FailingAggregate = Contract.create('aggregate', {
      version: '1.0.0',
      methods: {
        sum: {
          kind: 'clientStream' as const,
          input: z.object({ value: z.number() }),
          output: z.object({ total: z.number() }),
          errors: { TooBig: z.object({ limit: z.number() }) },
        },
      },
    });

    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });
    const host = await Host.create(
      FailingAggregate,
      {
        async sum(inputStream: AsyncIterable<{ value: number }>) {
          for await (const _item of inputStream) {
            throw { _tag: 'TooBig', payload: { limit: 0 } };
          }
          return { total: 0 };
        },
      } as never,
      hostTransport
    );

    const beforeSubjects = new Set(live.keys());

    const client = Client.create(FailingAggregate, clientTransport);
    async function* values() {
      yield { value: 1 };
    }
    let caught: ContractError | undefined;
    try {
      await client.sum(values());
    } catch (err) {
      caught = err as ContractError;
    }
    expect(caught!._tag).toBe('TooBig');

    await connection.flush();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const perCallSubjects = [...live.keys()].filter((s) => !beforeSubjects.has(s));
    expect(perCallSubjects.length).toBeGreaterThanOrEqual(2);
    for (const subject of perCallSubjects) {
      expect(live.get(subject)).toBe(0);
    }

    await host.stop();
    await connection.close();
  });
});
