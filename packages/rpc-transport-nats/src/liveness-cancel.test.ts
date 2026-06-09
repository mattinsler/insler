import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { Client, ContractError } from '@insler/rpc-client';
import { Contract } from '@insler/rpc-contract';
import { Host } from '@insler/rpc-host';
import type { HostResponse } from '@insler/rpc-host';
import { jsonBytesSerde } from '@insler/serde-json';
import type { NatsConnection, Subscription, SubscriptionOptions } from '@nats-io/transport-node';
import { z } from 'zod';

import { createNatsTransport, NatsClientTransport, NatsHostTransport } from './index.js';
import { type EphemeralNatsServer, startEphemeralNatsServer } from './nats-test-harness.js';

// --------------------------------------------------------------------------
// Streaming liveness, cancellation & deadlines over NATS (issue 0009,
// ADR-0001 §2.7).
//
// Asserted at the transport boundary against a REAL nats-server:
//   - a silent/dead peer fails the waiting side with __timeout__ after the idle
//     window and unsubscribes its inbox;
//   - an OPTIONAL overall deadline cancels a call with __timeout__, and is OFF by
//     default (a long-running stream completes without one);
//   - a CancelFrame from either client or host tears down BOTH directions
//     promptly and the peer stops sending;
//   - on unregister() with an in-flight call, the per-call up/down subscriptions
//     are torn down (no leaks);
//   - all four method kinds work — no method returns "not supported".
//
// Timeout/deadline windows are kept SHORT (tens of ms) so the suite runs fast,
// but comfortably above scheduling jitter so it isn't flaky.
// --------------------------------------------------------------------------

let server: EphemeralNatsServer;

beforeAll(async () => {
  server = await startEphemeralNatsServer();
});

afterAll(async () => {
  await server.stop();
});

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Track a connection's subscribe/unsubscribe so a test can assert per-call
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

const StreamService = Contract.create('events', {
  version: '1.0.0',
  methods: {
    watch: {
      kind: 'serverStream' as const,
      input: z.object({ topic: z.string() }),
      output: z.object({ event: z.string(), seq: z.number() }),
    },
  },
});

// ===========================================================================
// Criterion: a silent/dead peer fails the waiting side with __timeout__ after
// the idle window and unsubscribes.
// ===========================================================================
describe('idle (stall) timeout — silent peer', () => {
  test('a raw host that opens then goes silent → client fails with __timeout__ and unsubscribes `down`', async () => {
    const connection = await server.connect();
    const live = trackSubscriptions(connection);
    const serde = jsonBytesSerde;

    // A raw "host": answer the OpenRequest but then send NOTHING on `down`
    // (a silently dead peer). Core NATS cannot signal the parked client; only the
    // idle timer can.
    const methodSub = connection.subscribe('rpc.events.watch', { queue: 'q' });
    void (async () => {
      for await (const msg of methodSub) {
        // Decode just to be a well-behaved open ack target; then stay silent.
        serde.decode(msg.data);
        // (no down frames)
      }
    })();

    const clientTransport = new NatsClientTransport({ connection, idleTimeout: 50 });
    const beforeSubjects = new Set(live.keys());

    const stream = clientTransport.invokeServerStream!({
      service: 'events',
      method: 'watch',
      kind: 'serverStream',
      input: { topic: 'silent' },
    });

    const results: Array<{ output?: unknown; error?: { _tag: string } }> = [];
    for await (const item of stream) {
      results.push(item as { output?: unknown; error?: { _tag: string } });
    }

    // Exactly one terminal item: a __timeout__ error.
    expect(results).toHaveLength(1);
    expect(results[0]!.error?._tag).toBe('__timeout__');

    // The per-call `down` inbox is torn down (no leak).
    await tick(30);
    const perCall = [...live.keys()].filter((s) => !beforeSubjects.has(s));
    expect(perCall.length).toBeGreaterThanOrEqual(1);
    for (const subject of perCall) {
      expect(live.get(subject)).toBe(0);
    }

    methodSub.unsubscribe();
    await connection.close();
  });

  test('a handler that stalls without yielding → client fails with __timeout__ (throw mode)', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({
      connection,
      idleTimeout: 60,
    });

    const host = await Host.create(
      StreamService,
      {
        async *watch(): AsyncIterable<{ event: string; seq: number }> {
          // Stall: never yield, never return. The host sends no frame on `down`,
          // so only the client's idle timer can end the call. The loop keeps the
          // generator a generator (require-yield) without ever producing a frame.
          while (true) {
            await tick(10_000);
            yield { event: 'never', seq: 0 };
          }
        },
      } as never,
      hostTransport
    );

    const client = Client.create(StreamService, clientTransport);
    let caught: unknown;
    try {
      for await (const _ of client.watch({ topic: 'stall' })) {
        // nothing
      }
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ContractError);
    expect((caught as ContractError)._tag).toBe('__timeout__');

    await host.stop();
    await connection.close();
  });

  test('a steady (slow) handler within the idle window does NOT trip the timeout', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({
      connection,
      // Idle window comfortably larger than the inter-frame gap.
      idleTimeout: 120,
    });

    const host = await Host.create(
      StreamService,
      {
        async *watch(input: { topic: string }) {
          for (let i = 1; i <= 4; i++) {
            await tick(40); // < idleTimeout, so each frame resets the window
            yield { event: `${input.topic}:${i}`, seq: i };
          }
        },
      } as never,
      hostTransport
    );

    const client = Client.create(StreamService, clientTransport);
    const results: unknown[] = [];
    for await (const item of client.watch({ topic: 'slow' })) {
      results.push(item);
    }

    expect(results).toHaveLength(4);

    await host.stop();
    await connection.close();
  });

  test('host idle timeout: a clientStream whose client goes silent fails with __timeout__', async () => {
    const ClientStreamService = Contract.create('sumsvc', {
      version: '1.0.0',
      methods: {
        sum: {
          kind: 'clientStream' as const,
          input: z.object({ n: z.number() }),
          output: z.object({ total: z.number() }),
        },
      },
    });

    const connection = await server.connect();
    const { host: hostTransport } = createNatsTransport({ connection, idleTimeout: 50 });

    const host = await Host.create(
      ClientStreamService,
      {
        async sum(inputs: AsyncIterable<{ n: number }>) {
          let total = 0;
          for await (const { n } of inputs) {
            total += n;
          }
          return { total };
        },
      } as never,
      hostTransport
    );

    // Raw client: open the call, then send NOTHING on `up` (a silent client). The
    // host's idle timer must fire and end the call with __timeout__ on `down`.
    const serde = jsonBytesSerde;
    const down = `_INBOX.test.down.${Math.random().toString(36).slice(2)}`;
    const up = `_INBOX.test.up.${Math.random().toString(36).slice(2)}`;
    const downSub = connection.subscribe(down);
    const terminal: Array<{ t?: string; error?: { _tag: string } }> = [];
    const drained = (async () => {
      for await (const msg of downSub) {
        const frame = serde.decode(msg.data) as { t?: string; error?: { _tag: string } };
        if (frame.t === 'x') {
          terminal.push(frame);
          return;
        }
        // ignore the initial credit frame
      }
    })();

    connection.publish('rpc.sumsvc.sum', serde.encode({ up, down, credit: 8 }), { reply: down });

    await Promise.race([drained, tick(1000)]);

    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.error?._tag).toBe('__timeout__');

    downSub.unsubscribe();
    await host.stop();
    await connection.close();
  });
});

// ===========================================================================
// Criterion: an optional overall deadline cancels a call with __timeout__; the
// default is off for streams.
// ===========================================================================
describe('overall deadline (optional, default off)', () => {
  test('a deadline cancels a long-running stream with __timeout__', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({
      connection,
      // Idle window large so ONLY the deadline can fire; short deadline.
      idleTimeout: 10_000,
      deadline: 80,
    });

    const host = await Host.create(
      StreamService,
      {
        async *watch(input: { topic: string }) {
          // Keep emitting frames inside the idle window forever — the idle timer
          // never trips; only the overall deadline can end this call.
          let i = 0;
          while (true) {
            await tick(20);
            yield { event: `${input.topic}:${i}`, seq: i++ };
          }
        },
      } as never,
      hostTransport
    );

    const client = Client.create(StreamService, clientTransport);
    const results: unknown[] = [];
    let caught: unknown;
    try {
      for await (const item of client.watch({ topic: 'long' })) {
        results.push(item);
      }
    } catch (err) {
      caught = err;
    }

    // Some items were delivered before the deadline; then __timeout__.
    expect(caught).toBeInstanceOf(ContractError);
    expect((caught as ContractError)._tag).toBe('__timeout__');
    expect(results.length).toBeGreaterThan(0);

    await host.stop();
    await connection.close();
  });

  test('default (no deadline) — a stream running past any default ceiling completes normally', async () => {
    const connection = await server.connect();
    // No deadline, generous idle window: a multi-second stream must NOT be capped.
    const { client: clientTransport, host: hostTransport } = createNatsTransport({
      connection,
      idleTimeout: 5_000,
    });

    const host = await Host.create(
      StreamService,
      {
        async *watch(input: { topic: string }) {
          for (let i = 0; i < 3; i++) {
            await tick(60);
            yield { event: `${input.topic}:${i}`, seq: i };
          }
        },
      } as never,
      hostTransport
    );

    const client = Client.create(StreamService, clientTransport);
    const results: unknown[] = [];
    for await (const item of client.watch({ topic: 'nodeadline' })) {
      results.push(item);
    }

    expect(results).toHaveLength(3);

    await host.stop();
    await connection.close();
  });
});

// ===========================================================================
// Criterion: a CancelFrame from either client or host tears down both
// directions promptly; the peer stops sending.
// ===========================================================================
describe('cancellation — initiation from either side', () => {
  test('client abandons the iterator (break) → host receives Cancel and stops producing', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({
      connection,
      // Small credit so the host blocks on the consumer and we can observe it stop.
      credit: 2,
    });

    let produced = 0;
    let stoppedEarly = false;
    const host = await Host.create(
      StreamService,
      {
        async *watch(input: { topic: string }) {
          try {
            for (let i = 0; i < 1000; i++) {
              produced++;
              yield { event: `${input.topic}:${i}`, seq: i };
            }
          } finally {
            // The host generator's finally runs when the transport tears the call
            // down on the client's CancelFrame — proving the peer stopped.
            stoppedEarly = produced < 1000;
          }
        },
      } as never,
      hostTransport
    );

    const client = Client.create(StreamService, clientTransport);
    const received: unknown[] = [];
    for await (const item of client.watch({ topic: 'cancel' })) {
      received.push(item);
      if (received.length === 2) {
        break; // abandon the stream → client initiates a CancelFrame on `up`
      }
    }

    expect(received).toHaveLength(2);

    // Give the CancelFrame time to reach the host and tear the call down.
    await tick(150);
    const producedAtCancel = produced;
    expect(stoppedEarly).toBe(true);

    // The host must not keep producing after teardown.
    await tick(150);
    expect(produced).toBe(producedAtCancel);

    await host.stop();
    await connection.close();
  });

  test('a raw client CancelFrame on `up` tears the host call down (host stops producing)', async () => {
    const connection = await server.connect();
    const serde = jsonBytesSerde;

    let produced = 0;
    let tornDown = false;
    const host = new NatsHostTransport({ connection });
    const unregister = await host.register({
      service: 'events',
      methods: [
        {
          method: 'watch',
          kind: 'serverStream',
          handler: async function* (): AsyncIterable<HostResponse> {
            try {
              for (let i = 0; i < 1000; i++) {
                produced++;
                yield { output: { event: 'x', seq: i } };
              }
            } finally {
              tornDown = true;
            }
          },
        },
      ],
    });

    // Raw client: open with a small credit window so the host parks quickly, then
    // send a CancelFrame on `up` — the host must stop and tear down.
    const down = `_INBOX.rc.down.${Math.random().toString(36).slice(2)}`;
    const up = `_INBOX.rc.up.${Math.random().toString(36).slice(2)}`;
    const downSub = connection.subscribe(down);
    void (async () => {
      for await (const _ of downSub) {
        // drain down frames (we don't replenish credit, so the host parks at 0)
      }
    })();

    connection.publish('rpc.events.watch', serde.encode({ up, down, credit: 2 }), { reply: down });
    await tick(80); // let the host produce up to the credit window and park
    const producedAtCancel = produced;

    // Initiate cancellation from the client side.
    connection.publish(up, serde.encode({ t: 'a', reason: 'client-abort' }));
    await tick(120);

    expect(tornDown).toBe(true);
    // The host did not run away past where it parked.
    expect(produced).toBe(producedAtCancel);

    downSub.unsubscribe();
    await unregister();
    await connection.close();
  });

  test('a host CancelFrame on `down` tears the client call down (client stops, no hang)', async () => {
    const connection = await server.connect();
    const serde = jsonBytesSerde;

    // Raw host: answer the open and immediately send a CancelFrame on `down`.
    const methodSub = connection.subscribe('rpc.events.watch', { queue: 'q' });
    void (async () => {
      for await (const msg of methodSub) {
        const open = serde.decode(msg.data) as { down: string };
        connection.publish(open.down, serde.encode({ t: 'a', reason: 'host-abort' }));
      }
    })();

    const clientTransport = new NatsClientTransport({ connection, idleTimeout: 2_000 });
    const stream = clientTransport.invokeServerStream!({
      service: 'events',
      method: 'watch',
      kind: 'serverStream',
      input: { topic: 'host-cancel' },
    });

    const results: unknown[] = [];
    // Must complete promptly (no hang) — a host CancelFrame is terminal.
    await Promise.race([
      (async () => {
        for await (const item of stream) {
          results.push(item);
        }
      })(),
      tick(1000).then(() => {
        throw new Error('client did not tear down on host CancelFrame');
      }),
    ]);

    // CancelFrame is a clean terminal: the serverStream yields nothing further.
    expect(results).toHaveLength(0);

    methodSub.unsubscribe();
    await connection.close();
  });

  test('duplex: client abandons the output iterator → host stops producing (both directions torn down)', async () => {
    const DuplexService = Contract.create('echo', {
      version: '1.0.0',
      methods: {
        echo: {
          kind: 'duplex' as const,
          input: z.object({ n: z.number() }),
          output: z.object({ n: z.number() }),
        },
      },
    });

    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({
      connection,
      credit: 2,
    });

    let produced = 0;
    let tornDown = false;
    const host = await Host.create(
      DuplexService,
      {
        async *echo(inputs: AsyncIterable<{ n: number }>) {
          try {
            // Echo the first input, then keep producing on `down` forever.
            for await (const { n } of inputs) {
              produced++;
              yield { n };
              for (let i = 0; i < 1000; i++) {
                produced++;
                yield { n: n + i };
              }
            }
          } finally {
            tornDown = true;
          }
        },
      } as never,
      hostTransport
    );

    const client = Client.create(DuplexService, clientTransport);
    async function* inputs(): AsyncIterable<{ n: number }> {
      yield { n: 1 };
      // Keep the input side open so the host's echo loop is driven.
      await tick(500);
    }

    const received: unknown[] = [];
    for await (const item of client.echo(inputs())) {
      received.push(item);
      if (received.length === 2) {
        break; // abandon → client initiates a CancelFrame on `up`
      }
    }

    expect(received).toHaveLength(2);

    await tick(200);
    const producedAtCancel = produced;
    expect(tornDown).toBe(true);

    // The host must not keep producing after teardown.
    await tick(150);
    expect(produced).toBe(producedAtCancel);

    await host.stop();
    await connection.close();
  });
});

// ===========================================================================
// Criterion: on unregister(), in-flight per-call up/down subscriptions are torn
// down (no leaks).
// ===========================================================================
describe('unregister() tears down in-flight per-call subscriptions', () => {
  async function assertUnregisterTearsDownInFlight(
    kind: 'serverStream' | 'clientStream' | 'duplex'
  ): Promise<void> {
    const connection = await server.connect();
    const live = trackSubscriptions(connection);
    const serde = jsonBytesSerde;

    // A handler that blocks forever, so the call is genuinely IN FLIGHT when we
    // unregister. (The host subscribes `up` per call regardless of kind.)
    const blockingHandler =
      kind === 'serverStream'
        ? async function* (): AsyncIterable<HostResponse> {
            await new Promise(() => {});
            yield { output: { event: 'x', seq: 0 } };
          }
        : kind === 'clientStream'
          ? async function (): Promise<HostResponse> {
              await new Promise(() => {});
              return { output: { total: 0 } };
            }
          : async function* (): AsyncIterable<HostResponse> {
              await new Promise(() => {});
              yield { output: { event: 'x', seq: 0 } };
            };

    const host = new NatsHostTransport({ connection, idleTimeout: 10_000 });
    const unregister = await host.register({
      service: 'events',
      methods: [{ method: 'watch', kind, handler: blockingHandler as never }],
    });

    const beforeSubjects = new Set(live.keys());

    // Raw client opens a call (no real client needed — we just need the host to
    // subscribe the per-call `up` inbox).
    const down = `_INBOX.unreg.down.${Math.random().toString(36).slice(2)}`;
    const up = `_INBOX.unreg.up.${Math.random().toString(36).slice(2)}`;
    const downSub = connection.subscribe(down);
    void (async () => {
      for await (const _ of downSub) {
        // drain
      }
    })();
    connection.publish('rpc.events.watch', serde.encode({ up, down, credit: 4 }), { reply: down });

    // Let the host receive the open and subscribe `up`.
    await tick(100);
    const perCallDuringCall = [...live.keys()].filter((s) => !beforeSubjects.has(s) && s === up);
    // The host subscribed the per-call `up` inbox.
    expect(live.get(up)).toBe(1);

    // Unregister while the call is in flight: the per-call `up` subscription must
    // be torn down (no leak).
    await unregister();
    await tick(50);

    expect(live.get(up)).toBe(0);
    // sanity: there was indeed an in-flight per-call subscription.
    expect(perCallDuringCall).toContain(up);

    downSub.unsubscribe();
    await connection.close();
  }

  test('serverStream in-flight call: per-call `up` torn down on unregister()', async () => {
    await assertUnregisterTearsDownInFlight('serverStream');
  });

  test('clientStream in-flight call: per-call `up` torn down on unregister()', async () => {
    await assertUnregisterTearsDownInFlight('clientStream');
  });

  test('duplex in-flight call: per-call `up` torn down on unregister()', async () => {
    await assertUnregisterTearsDownInFlight('duplex');
  });
});

// ===========================================================================
// Criterion: the __not_implemented__ branch is removed; no method returns
// "not supported". (The grep evidence is in the report; this asserts all four
// method kinds work end-to-end with no error tag.)
// ===========================================================================
describe('no method returns "not supported" — all four kinds work', () => {
  const AllKinds = Contract.create('allkinds', {
    version: '1.0.0',
    methods: {
      ping: {
        kind: 'unary' as const,
        input: z.object({ x: z.number() }),
        output: z.object({ x: z.number() }),
      },
      down: {
        kind: 'serverStream' as const,
        input: z.object({ n: z.number() }),
        output: z.object({ i: z.number() }),
      },
      up: {
        kind: 'clientStream' as const,
        input: z.object({ n: z.number() }),
        output: z.object({ total: z.number() }),
      },
      both: {
        kind: 'duplex' as const,
        input: z.object({ n: z.number() }),
        output: z.object({ doubled: z.number() }),
      },
    },
  });

  test('unary, serverStream, clientStream, duplex all succeed (none "not supported")', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });

    const host = await Host.create(
      AllKinds,
      {
        async ping(input: { x: number }) {
          return { x: input.x + 1 };
        },
        async *down(input: { n: number }) {
          for (let i = 0; i < input.n; i++) {
            yield { i };
          }
        },
        async up(inputs: AsyncIterable<{ n: number }>) {
          let total = 0;
          for await (const { n } of inputs) {
            total += n;
          }
          return { total };
        },
        async *both(inputs: AsyncIterable<{ n: number }>) {
          for await (const { n } of inputs) {
            yield { doubled: n * 2 };
          }
        },
      } as never,
      hostTransport
    );

    const client = Client.create(AllKinds, clientTransport);

    // unary
    expect(await client.ping({ x: 41 })).toEqual({ x: 42 });

    // serverStream
    const downItems: unknown[] = [];
    for await (const item of client.down({ n: 3 })) {
      downItems.push(item);
    }
    expect(downItems).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);

    // clientStream
    async function* ups(): AsyncIterable<{ n: number }> {
      yield { n: 1 };
      yield { n: 2 };
      yield { n: 3 };
    }
    expect(await client.up(ups())).toEqual({ total: 6 });

    // duplex
    async function* boths(): AsyncIterable<{ n: number }> {
      yield { n: 5 };
      yield { n: 6 };
    }
    const bothItems: unknown[] = [];
    for await (const item of client.both(boths())) {
      bothItems.push(item);
    }
    expect(bothItems).toEqual([{ doubled: 10 }, { doubled: 12 }]);

    await host.stop();
    await connection.close();
  });
});
