import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { Client, ContractError } from '@insler/rpc/client';
import type { ClientRequest, ClientResponse, ClientTransport } from '@insler/rpc/client';
import { Contract } from '@insler/rpc/contract';
import { Host } from '@insler/rpc/host';
import type { HostRequest, HostResponse } from '@insler/rpc/host';
import { createMemoryTransport } from '@insler/rpc/transport-memory';
import { cborSerde } from '@insler/serde-cbor';
import { jsonBytesSerde } from '@insler/serde-json';
import type { NatsConnection, Subscription, SubscriptionOptions } from '@nats-io/transport-node';
import { z } from 'zod';

import { createNatsTransport, NatsClientTransport, NatsHostTransport } from './index.js';
import type { Frame } from './index.js';
import { type EphemeralNatsServer, startEphemeralNatsServer } from './nats-test-harness.js';

// --------------------------------------------------------------------------
// duplex over NATS (issue 0008, ADR-0001 §2.2/§2.4).
//
// Both directions stream INDEPENDENTLY and CONCURRENTLY: the client streams
// inputs on `up`, the host streams outputs on `down`; each half-closes with its
// OWN EndFrame, and the call completes only when BOTH directions have sent an
// EndFrame. Independent credit-based backpressure runs on each direction (a
// CreditController/grantOnConsume pair per direction). An ErrorFrame/CancelFrame
// tears down BOTH directions.
//
// Reuses the 0004-0007 machinery (open handshake, frames, streaming, the
// CreditController/grantOnConsume helpers, the 0006 error/fault mapping) and the
// 0007 host-ready handshake (the host's first `down` CreditFrame signals it is
// subscribed on `up`, so the client never publishes `up` frames before the host
// is listening).
//
// Assertions are at the transport boundary — what the Client yields / which
// `__*__` tag surfaces — mirroring transport-memory's observable duplex result.
// --------------------------------------------------------------------------

let server: EphemeralNatsServer;

beforeAll(async () => {
  server = await startEphemeralNatsServer();
});

afterAll(async () => {
  await server.stop();
});

// The canonical parity contract — same shape transport-memory's duplex suite
// uses (the `EchoService.echo` case), so the observable result compares directly.
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

const echoHandlers = {
  async *echo(inputStream: AsyncIterable<{ msg: string }>) {
    for await (const item of inputStream) {
      yield { reply: `echo:${item.msg}` };
    }
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

describe('duplex over NATS — end-to-end parity with transport-memory', () => {
  test('transforms each input into an output (mirrors memory)', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });

    const host = await Host.create(EchoService, echoHandlers, hostTransport);
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
    await connection.close();
  });

  test('handler can yield more items than input (mirrors memory)', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });

    const host = await Host.create(
      EchoService,
      {
        async *echo(inputStream: AsyncIterable<{ msg: string }>) {
          for await (const item of inputStream) {
            yield { reply: `${item.msg}:1` };
            yield { reply: `${item.msg}:2` };
          }
        },
      } as never,
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
    await connection.close();
  });

  test('observable result matches transport-memory for the same call', async () => {
    async function* inputs() {
      yield { msg: 'x' };
      yield { msg: 'y' };
      yield { msg: 'z' };
    }

    // transport-memory: the canonical observable result.
    const memoryTransport = createMemoryTransport();
    const memoryHost = await Host.create(EchoService, echoHandlers, memoryTransport.host);
    const memoryClient = Client.create(EchoService, memoryTransport.client);
    const memoryResults: unknown[] = [];
    for await (const item of memoryClient.echo(inputs())) {
      memoryResults.push(item);
    }
    await memoryHost.stop();

    // NATS: the same call, same handler.
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });
    const natsHost = await Host.create(EchoService, echoHandlers, hostTransport);
    const natsClient = Client.create(EchoService, clientTransport);
    const natsResults: unknown[] = [];
    for await (const item of natsClient.echo(inputs())) {
      natsResults.push(item);
    }
    await natsHost.stop();
    await connection.close();

    expect(natsResults).toEqual(memoryResults);
    expect(natsResults).toEqual([{ reply: 'echo:x' }, { reply: 'echo:y' }, { reply: 'echo:z' }]);
  });

  test('empty input stream → host produces nothing, call completes', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });

    const host = await Host.create(EchoService, echoHandlers, hostTransport);
    const client = Client.create(EchoService, clientTransport);

    async function* inputs(): AsyncIterable<{ msg: string }> {
      // yield nothing — the client sends only its terminal EndFrame on `up`.
    }

    const results: unknown[] = [];
    for await (const item of client.echo(inputs())) {
      results.push(item);
    }
    expect(results).toEqual([]);

    await host.stop();
    await connection.close();
  });
});

describe('duplex over NATS — concurrent independent directions', () => {
  // The point of duplex: the two directions are NOT request-then-response. The
  // host must be able to emit outputs while the client is still streaming inputs,
  // and the directions interleave concurrently. This contract has the host emit
  // an output per input AND echo, but the test drives them so that the host's
  // output for input N is observed by the client BEFORE the client has produced
  // input N+1 — proving the directions run concurrently rather than the client
  // sending everything first and only then receiving.
  const InterleaveService = Contract.create('interleave', {
    version: '1.0.0',
    methods: {
      pingpong: {
        kind: 'duplex' as const,
        input: z.object({ ball: z.number() }),
        output: z.object({ pong: z.number() }),
      },
    },
  });

  test('host emits an output per input while the client is still streaming (interleaved)', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });

    const host = await Host.create(
      InterleaveService,
      {
        async *pingpong(inputStream: AsyncIterable<{ ball: number }>) {
          for await (const item of inputStream) {
            // Echo each ball straight back as it arrives.
            yield { pong: item.ball };
          }
        },
      } as never,
      hostTransport
    );
    const client = Client.create(InterleaveService, clientTransport);

    // The client only produces the next input AFTER it has observed the host's
    // pong for the previous one. If the transport serialized the directions
    // (drain all inputs, THEN deliver outputs) this would deadlock and time out.
    const received: number[] = [];
    // A re-armable one-shot gate: `wait()` blocks until the next `release()`.
    const gate = (() => {
      let resolve: () => void = () => {};
      let promise = new Promise<void>((r) => {
        resolve = r;
      });
      return {
        wait: (): Promise<void> => promise,
        rearm: (): void => {
          promise = new Promise<void>((r) => {
            resolve = r;
          });
        },
        release: (): void => resolve(),
      };
    })();

    async function* balls(): AsyncIterable<{ ball: number }> {
      for (let n = 0; n < 5; n++) {
        yield { ball: n };
        // Wait for the host's pong for this ball before sending the next.
        await gate.wait();
        gate.rearm();
      }
    }

    for await (const item of client.pingpong(balls())) {
      received.push((item as { pong: number }).pong);
      gate.release();
    }

    expect(received).toEqual([0, 1, 2, 3, 4]);

    await host.stop();
    await connection.close();
  });

  test('the host keeps producing on down after the client half-closes up', async () => {
    // After the client sends its `up` EndFrame (no more inputs), the host's
    // handler may still emit outputs on `down`. The call completes only when the
    // host then sends its own `down` EndFrame. This proves the two half-closes
    // are independent (down outlives up).
    const TrailingService = Contract.create('trailing', {
      version: '1.0.0',
      methods: {
        drain: {
          kind: 'duplex' as const,
          input: z.object({ n: z.number() }),
          output: z.object({ out: z.number() }),
        },
      },
    });

    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });

    const host = await Host.create(
      TrailingService,
      {
        async *drain(inputStream: AsyncIterable<{ n: number }>) {
          const seen: number[] = [];
          for await (const item of inputStream) {
            seen.push(item.n);
          }
          // Only AFTER the client half-closed `up` do we emit outputs.
          for (const n of seen) {
            yield { out: n * 10 };
          }
        },
      } as never,
      hostTransport
    );
    const client = Client.create(TrailingService, clientTransport);

    async function* inputs() {
      yield { n: 1 };
      yield { n: 2 };
      yield { n: 3 };
    }

    const results: unknown[] = [];
    for await (const item of client.drain(inputs())) {
      results.push(item);
    }

    expect(results).toEqual([{ out: 10 }, { out: 20 }, { out: 30 }]);

    await host.stop();
    await connection.close();
  });
});

describe('duplex over NATS — independent backpressure per direction', () => {
  test('a slow client consumer bounds the host-produced-but-unconsumed output on down', async () => {
    const TICKS = 20;
    const CREDIT = 3;

    const FirehoseService = Contract.create('firehose', {
      version: '1.0.0',
      methods: {
        run: {
          kind: 'duplex' as const,
          input: z.object({ go: z.boolean() }),
          output: z.object({ n: z.number() }),
        },
      },
    });

    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({
      connection,
      // The `down` window: how many outputs the host may have in flight before
      // it pauses for the client to consume.
      credit: CREDIT,
    });

    // The host produces outputs as fast as it can on `down` once the single input
    // arrives. It records how many it has PRODUCED (handed to the transport).
    let produced = 0;
    const host = await Host.create(
      FirehoseService,
      {
        async *run(inputStream: AsyncIterable<{ go: boolean }>) {
          for await (const _go of inputStream) {
            for (let n = 0; n < TICKS; n++) {
              produced = n + 1;
              yield { n };
            }
          }
        },
      } as never,
      hostTransport
    );
    const client = Client.create(FirehoseService, clientTransport);

    async function* inputs() {
      yield { go: true };
    }

    // The client consumes SLOWLY; without backpressure the host would race to
    // TICKS immediately. We sample the gap between produced and consumed.
    let consumed = 0;
    let maxInFlight = 0;
    for await (const _item of client.run(inputs())) {
      consumed += 1;
      maxInFlight = Math.max(maxInFlight, produced - consumed);
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(consumed).toBe(TICKS);
    expect(produced).toBe(TICKS);
    // The host never ran more than ~one window ahead of the client's consumption.
    expect(maxInFlight).toBeLessThanOrEqual(CREDIT + 1);

    await host.stop();
    await connection.close();
  });

  test('a slow host consumer bounds the client-produced-but-unconsumed input on up', async () => {
    const TICKS = 20;
    const CREDIT = 3;

    const PushService = Contract.create('push', {
      version: '1.0.0',
      methods: {
        feed: {
          kind: 'duplex' as const,
          input: z.object({ n: z.number() }),
          output: z.object({ ack: z.number() }),
        },
      },
    });

    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({
      connection,
      // The `up` window the host grants the client (it doubles as the initial
      // up-credit grant).
      credit: CREDIT,
    });

    // The host consumes inputs SLOWLY (and emits nothing on `down` until the end),
    // so the client's `up` production is bounded by the credit the host grants.
    let consumed = 0;
    const host = await Host.create(
      PushService,
      {
        async *feed(inputStream: AsyncIterable<{ n: number }>) {
          for await (const _item of inputStream) {
            consumed += 1;
            await new Promise((r) => setTimeout(r, 15));
          }
          yield { ack: consumed };
        },
      } as never,
      hostTransport
    );
    const client = Client.create(PushService, clientTransport);

    let produced = 0;
    let maxInFlight = 0;
    async function* fastProducer() {
      for (let n = 0; n < TICKS; n++) {
        produced = n + 1;
        maxInFlight = Math.max(maxInFlight, produced - consumed);
        yield { n };
      }
    }

    const results: unknown[] = [];
    for await (const item of client.feed(fastProducer())) {
      results.push(item);
    }

    expect(results).toEqual([{ ack: TICKS }]);
    expect(produced).toBe(TICKS);
    // The client never ran more than ~one window ahead of the host's consumption.
    expect(maxInFlight).toBeLessThanOrEqual(CREDIT + 1);

    await host.stop();
    await connection.close();
  });

  test('an input/output stream longer than either window completes (both sides resume)', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({
      connection,
      credit: 2,
    });

    const host = await Host.create(EchoService, echoHandlers, hostTransport);
    const client = Client.create(EchoService, clientTransport);

    async function* inputs() {
      for (let n = 0; n < 50; n++) {
        yield { msg: `m${n}` };
      }
    }

    const results: unknown[] = [];
    for await (const item of client.echo(inputs())) {
      results.push(item);
    }

    expect(results).toHaveLength(50);
    expect(results[0]).toEqual({ reply: 'echo:m0' });
    expect(results[49]).toEqual({ reply: 'echo:m49' });

    await host.stop();
    await connection.close();
  });
});

describe('duplex over NATS — mid-stream error & fault mapping (tears down both directions)', () => {
  test('declared contract error mid-stream → that typed error, prior items delivered (mirrors memory)', async () => {
    const FailingEcho = Contract.create('echo', {
      version: '1.0.0',
      methods: {
        echo: {
          kind: 'duplex' as const,
          input: z.object({ msg: z.string() }),
          output: z.object({ reply: z.string() }),
          errors: {
            EchoFailed: z.object({ msg: z.string() }),
          },
        },
      },
    });

    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });

    const host = await Host.create(
      FailingEcho,
      {
        async *echo(inputStream: AsyncIterable<{ msg: string }>) {
          for await (const item of inputStream) {
            if (item.msg === 'fail') {
              throw { _tag: 'EchoFailed', payload: { msg: item.msg } };
            }
            yield { reply: `echo:${item.msg}` };
          }
        },
      } as never,
      hostTransport
    );
    const client = Client.create(FailingEcho, clientTransport);

    async function* inputs() {
      yield { msg: 'ok' };
      yield { msg: 'fail' };
    }

    const results: unknown[] = [];
    let caught: ContractError | undefined;
    try {
      for await (const item of client.echo(inputs())) {
        results.push(item);
      }
      expect.unreachable();
    } catch (err) {
      caught = err as ContractError;
    }

    expect(caught).toBeInstanceOf(ContractError);
    expect(caught!._tag).toBe('EchoFailed');
    expect(caught!.payload).toEqual({ msg: 'fail' });
    // Already-yielded items remain delivered.
    expect(results).toEqual([{ reply: 'echo:ok' }]);

    await host.stop();
    await connection.close();
  });

  test('declared contract error surfaces at the transport boundary (result-mode client still throws on the iterator, as memory does)', async () => {
    // A streaming method's iterator throws the typed ContractError regardless of
    // the client's `errors` strategy — the `errors: 'result'` wrapper applies to
    // unary returns, not to a stream's terminal (transport-memory behaves the same:
    // its duplex error test catches a throw). We assert the typed error surfaces and
    // is INDEPENDENT of the result-mode option, mirroring memory's observable result.
    const FailingEcho = Contract.create('echo', {
      version: '1.0.0',
      methods: {
        echo: {
          kind: 'duplex' as const,
          input: z.object({ msg: z.string() }),
          output: z.object({ reply: z.string() }),
          errors: { EchoFailed: z.object({ msg: z.string() }) },
        },
      },
    });

    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });

    const host = await Host.create(
      FailingEcho,
      {
        async *echo(inputStream: AsyncIterable<{ msg: string }>) {
          for await (const item of inputStream) {
            throw { _tag: 'EchoFailed', payload: { msg: item.msg } };
          }
        },
      } as never,
      hostTransport
    );
    const client = Client.create(FailingEcho, clientTransport, { errors: 'result' });

    async function* inputs() {
      yield { msg: 'boom' };
    }

    let caught: ContractError | undefined;
    try {
      for await (const _item of client.echo(inputs())) {
        // drain
      }
      expect.unreachable();
    } catch (err) {
      caught = err as ContractError;
    }

    expect(caught).toBeInstanceOf(ContractError);
    expect(caught!._tag).toBe('EchoFailed');
    expect(caught!.payload).toEqual({ msg: 'boom' });

    await host.stop();
    await connection.close();
  });

  test('undeclared host throw collapses to __unknown__ (never leaks internals)', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });

    const host = await Host.create(
      EchoService,
      {
        async *echo(inputStream: AsyncIterable<{ msg: string }>) {
          for await (const _item of inputStream) {
            const boom = new Error('internal failure') as Error & { internalDetail?: unknown };
            boom.internalDetail = { dbPassword: 'super-secret-9000' };
            throw boom;
          }
        },
      } as never,
      hostTransport
    );
    const client = Client.create(EchoService, clientTransport);

    async function* inputs() {
      yield { msg: 'hi' };
    }

    let caught: ContractError | undefined;
    try {
      for await (const _item of client.echo(inputs())) {
        // drain
      }
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

    const host = await Host.create(EchoService, echoHandlers, hostTransport);
    const client = Client.create(EchoService, clientTransport);

    async function* badInputs() {
      yield { msg: 'ok' };
      yield { bad: 123 } as never;
    }

    let caught: ContractError | undefined;
    try {
      for await (const _item of client.echo(badInputs())) {
        // drain
      }
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

    // A raw "host": grant the client its initial `up` window (also the host-ready
    // signal), then once the client sends its first `up` frame, publish a CORRUPT
    // frame on `down`. The client (jsonBytesSerde) fails to decode it -> __serde__.
    const sub = connection.subscribe('rpc.echo.echo', { queue: 'q' });
    void (async () => {
      for await (const msg of sub) {
        const open = serde.decode(msg.data) as { up: string; down: string };
        // Host-ready: grant the initial `up` window so the client may publish.
        connection.publish(open.down, serde.encode({ t: 'c', n: 1024 }));
        const upSub = connection.subscribe(open.up);
        void (async () => {
          for await (const upMsg of upSub) {
            const frame = serde.decode(upMsg.data) as Frame;
            if (frame.t === 'd' || frame.t === 'e') {
              connection.publish(open.down, new Uint8Array([0xff, 0xfe, 0xfd, 0x00, 0x01]));
              upSub.unsubscribe();
              return;
            }
          }
        })();
      }
    })();

    const clientTransport = new NatsClientTransport({ connection });
    const client = Client.create(EchoService, clientTransport);

    async function* inputs() {
      yield { msg: 'x' };
    }

    let caught: ContractError | undefined;
    try {
      for await (const _item of client.echo(inputs())) {
        // drain
      }
      expect.unreachable();
    } catch (err) {
      caught = err as ContractError;
    }

    expect(caught).toBeInstanceOf(ContractError);
    expect(caught!._tag).toBe('__serde__');

    sub.unsubscribe();
    await connection.close();
  });

  test('on a terminal ErrorFrame, both directions stop and both inboxes unsubscribe', async () => {
    const connection = await server.connect();
    const live = trackSubscriptions(connection);

    const FailingEcho = Contract.create('echo', {
      version: '1.0.0',
      methods: {
        echo: {
          kind: 'duplex' as const,
          input: z.object({ msg: z.string() }),
          output: z.object({ reply: z.string() }),
          errors: { EchoFailed: z.object({ msg: z.string() }) },
        },
      },
    });

    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });
    const host = await Host.create(
      FailingEcho,
      {
        async *echo(inputStream: AsyncIterable<{ msg: string }>) {
          for await (const item of inputStream) {
            throw { _tag: 'EchoFailed', payload: { msg: item.msg } };
          }
        },
      } as never,
      hostTransport
    );

    const beforeSubjects = new Set(live.keys());

    const client = Client.create(FailingEcho, clientTransport);
    async function* inputs() {
      yield { msg: 'boom' };
    }
    let caught: ContractError | undefined;
    try {
      for await (const _item of client.echo(inputs())) {
        // drain
      }
    } catch (err) {
      caught = err as ContractError;
    }
    expect(caught!._tag).toBe('EchoFailed');

    await connection.flush();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Both directions' per-call inboxes are back to zero live subscriptions.
    const perCallSubjects = [...live.keys()].filter((s) => !beforeSubjects.has(s));
    expect(perCallSubjects.length).toBeGreaterThanOrEqual(2);
    for (const subject of perCallSubjects) {
      expect(live.get(subject)).toBe(0);
    }

    await host.stop();
    await connection.close();
  });
});

describe('duplex over NATS — serde round-trip', () => {
  test('inputs and outputs round-trip through a NON-JSON serde (CBOR)', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({
      connection,
      serde: cborSerde,
    });

    const host = await Host.create(EchoService, echoHandlers, hostTransport);
    const client = Client.create(EchoService, clientTransport);

    async function* inputs() {
      yield { msg: 'one' };
      yield { msg: 'two' };
    }

    const results: unknown[] = [];
    for await (const item of client.echo(inputs())) {
      results.push(item);
    }
    expect(results).toEqual([{ reply: 'echo:one' }, { reply: 'echo:two' }]);

    await host.stop();
    await connection.close();
  });
});

describe('duplex over NATS — context/metadata propagation', () => {
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

  test('context on the open request reaches the handler (parity with unary)', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });

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
      } as never,
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
    await connection.close();
  });
});

describe('duplex over NATS — middleware composition (transport seam)', () => {
  test('composes with a client middleware and a host middleware', async () => {
    // End-to-end streaming middleware is not threaded by Client.create/Host.create
    // (a known client/host gap, out of scope per the PRD), so we compose middleware
    // at the transport seam — exactly as issues 0004/0007 did: a client-side
    // wrapper mutates the ClientRequest before invokeDuplex; a host-side wrapper
    // observes/annotates the HostRequest around the registered duplex handler.
    const connection = await server.connect();

    const clientSeen: ClientRequest[] = [];
    const hostSeen: HostRequest[] = [];

    // Host middleware wraps the registered duplex handler (an async generator).
    const baseHandler = async function* (
      req: HostRequest,
      inputStream: AsyncIterable<unknown>
    ): AsyncIterable<HostResponse> {
      hostSeen.push(req);
      for await (const item of inputStream) {
        yield {
          output: {
            reply: `${req.metadata?.['x-from-client'] ?? 'none'}:${(item as { msg: string }).msg}`,
          },
        };
      }
    };
    const hostMiddleware =
      (
        inner: (req: HostRequest, s: AsyncIterable<unknown>) => AsyncIterable<HostResponse>
      ): ((req: HostRequest, s: AsyncIterable<unknown>) => AsyncIterable<HostResponse>) =>
      (req, s) =>
        inner({ ...req, metadata: { ...req.metadata, 'x-host-mw': 'seen' } }, s);

    const host = new NatsHostTransport({ connection });
    const unregister = await host.register({
      service: 'echo',
      methods: [{ method: 'echo', kind: 'duplex', handler: hostMiddleware(baseHandler) }],
    });

    // Client middleware wraps invokeDuplex.
    const baseTransport = new NatsClientTransport({ connection });
    const clientMiddleware = (
      req: ClientRequest,
      inputStream: AsyncIterable<unknown>,
      next: (r: ClientRequest, s: AsyncIterable<unknown>) => AsyncIterable<ClientResponse>
    ): AsyncIterable<ClientResponse> => {
      clientSeen.push(req);
      return next(
        { ...req, metadata: { ...req.metadata, 'x-from-client': 'client-mw' } },
        inputStream
      );
    };
    const wrappedTransport: ClientTransport = {
      invoke: (r) => baseTransport.invoke(r),
      invokeDuplex: (r, s) =>
        clientMiddleware(r, s, (rr, ss) => baseTransport.invokeDuplex!(rr, ss)),
    };

    async function* inputs() {
      yield { msg: 'a' };
      yield { msg: 'b' };
    }

    const results: unknown[] = [];
    for await (const item of wrappedTransport.invokeDuplex!(
      { service: 'echo', method: 'echo', kind: 'duplex' },
      inputs()
    )) {
      results.push((item as ClientResponse).output);
    }

    // Client middleware ran and its mutation reached the host.
    expect(clientSeen).toHaveLength(1);
    expect(hostSeen).toHaveLength(1);
    expect(hostSeen[0]!.metadata?.['x-from-client']).toBe('client-mw');
    // Host middleware ran (its annotation is visible to the inner handler).
    expect(hostSeen[0]!.metadata?.['x-host-mw']).toBe('seen');
    // The outputs carried the client-mutated metadata back out — full round-trip.
    expect(results).toEqual([{ reply: 'client-mw:a' }, { reply: 'client-mw:b' }]);

    await unregister();
    await connection.close();
  });
});

describe('duplex over NATS — wire shape & teardown', () => {
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
      service: 'echo',
      methods: [
        {
          method: 'echo',
          kind: 'duplex',
          handler: async function* (_req, inputStream) {
            // Drain inputs and produce nothing — this test only inspects the
            // method-subject subscription's queue group, not the stream behavior.
            for await (const _item of inputStream) {
              // no-op
            }
          },
        },
      ],
    });

    const methodSub = queues.find((q) => q.subject === 'rpc.echo.echo');
    expect(methodSub).toBeDefined();
    expect(methodSub!.queue).toBe('q');

    await unregister();
    await connection.close();
  });

  test('both inboxes are unsubscribed on normal completion (no leaks)', async () => {
    const connection = await server.connect();
    const live = trackSubscriptions(connection);

    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });
    const host = await Host.create(EchoService, echoHandlers, hostTransport);

    const beforeSubjects = new Set(live.keys());

    const client = Client.create(EchoService, clientTransport);
    async function* inputs() {
      yield { msg: 'a' };
      yield { msg: 'b' };
    }
    const results: unknown[] = [];
    for await (const item of client.echo(inputs())) {
      results.push(item);
    }
    expect(results).toEqual([{ reply: 'echo:a' }, { reply: 'echo:b' }]);

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
