import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { Client } from '@insler/rpc-client';
import { Contract } from '@insler/rpc-contract';
import { Host } from '@insler/rpc-host';
import type { HostResponse } from '@insler/rpc-host';
import { jsonBytesSerde } from '@insler/serde-json';
import type { NatsConnection } from '@nats-io/transport-node';
import { z } from 'zod';

import type { StatsResponse } from './discovery.js';
import { createNatsTransport, NatsHostTransport } from './index.js';
import { type EphemeralNatsServer, startEphemeralNatsServer } from './nats-test-harness.js';
import type { EndpointStats } from './stats.js';

// --------------------------------------------------------------------------
// ADR-32 discovery — STATS, STREAMING call-level accounting (issue 0012).
//
// Per docs/agents/libraries/rpc-transport-nats.md, wire-level/discovery behavior is
// asserted here against a REAL nats-server. The counted unit is the CALL, not the
// frame (ADR-0001 §1.4): for all three streaming kinds —
//   - a streaming call increments num_requests ONCE on open (not once per frame:
//     stream N items, num_requests grows by 1, not N);
//   - processing_time measures the open→close duration (a deliberately slow call
//     accrues a plausibly-large ns duration bracketing the wall-time, recorded at
//     CLOSE, not per frame);
//   - a call ending in ErrorFrame/CancelFrame (or timeout) increments num_errors
//     and sets last_error; a graceful EndFrame close does NOT.
//
// Everything is verified via $SRV.STATS on the wire. The unary accounting (0011)
// is in discovery-stats.test.ts and must not regress.
// --------------------------------------------------------------------------

let server: EphemeralNatsServer;

beforeAll(async () => {
  server = await startEphemeralNatsServer();
});

afterAll(async () => {
  await server.stop();
});

const enc = new TextEncoder();
const dec = new TextDecoder();
const serde = jsonBytesSerde;
const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function decodeStats(data: Uint8Array): StatsResponse {
  return JSON.parse(dec.decode(data)) as StatsResponse;
}

function endpointByName(stats: StatsResponse, name: string): EndpointStats {
  const ep = stats.endpoints.find((e) => e.name === name);
  if (!ep) {
    throw new Error(`No endpoint named '${name}' in STATS response`);
  }
  return ep;
}

async function fetchStats(
  connection: Awaited<ReturnType<EphemeralNatsServer['connect']>>,
  service: string
): Promise<StatsResponse> {
  const reply = await connection.request(`$SRV.STATS.${service}`, enc.encode(''), {
    timeout: 2000,
  });
  return decodeStats(reply.data);
}

// ===========================================================================
// One call counts as ONE request regardless of frame count, processing_time
// measures open→close, and a GRACEFUL close is NOT an error — exercised over
// the real Client/Host for all three streaming kinds.
// ===========================================================================
describe('streaming STATS — one call is one request (not one per frame), measured open→close', () => {
  const StreamService = Contract.create('stream-stats', {
    version: '1.0.0',
    methods: {
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

  test('serverStream: N output frames count as ONE request (num_requests += 1, not N)', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });
    const host = await Host.create(
      StreamService,
      {
        async *down(input: { n: number }) {
          for (let i = 0; i < input.n; i++) {
            yield { i };
          }
        },
        async up() {
          return { total: 0 };
        },
        async *both() {
          // no-op
        },
      } as never,
      hostTransport
    );
    const client = Client.create(StreamService, clientTransport);

    const items: unknown[] = [];
    for await (const item of client.down({ n: 5 })) {
      items.push(item);
    }
    // 5 DataFrames + an EndFrame flowed; the CALL is one unit.
    expect(items).toHaveLength(5);

    const ep = endpointByName(await fetchStats(connection, 'stream-stats'), 'down');
    expect(ep.num_requests).toBe(1);
    expect(ep.num_errors).toBe(0);
    expect('last_error' in ep).toBe(false);

    await host.stop();
    await connection.close();
  });

  test('clientStream: N input frames count as ONE request (num_requests += 1, not N)', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });
    const host = await Host.create(
      StreamService,
      {
        async *down() {
          // no-op
        },
        async up(inputs: AsyncIterable<{ n: number }>) {
          let total = 0;
          for await (const { n } of inputs) {
            total += n;
          }
          return { total };
        },
        async *both() {
          // no-op
        },
      } as never,
      hostTransport
    );
    const client = Client.create(StreamService, clientTransport);

    async function* ups(): AsyncIterable<{ n: number }> {
      yield { n: 1 };
      yield { n: 2 };
      yield { n: 3 };
      yield { n: 4 };
    }
    expect(await client.up(ups())).toEqual({ total: 10 });

    const ep = endpointByName(await fetchStats(connection, 'stream-stats'), 'up');
    expect(ep.num_requests).toBe(1);
    expect(ep.num_errors).toBe(0);
    expect('last_error' in ep).toBe(false);

    await host.stop();
    await connection.close();
  });

  test('duplex: many frames both directions count as ONE request (num_requests += 1)', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });
    const host = await Host.create(
      StreamService,
      {
        async *down() {
          // no-op
        },
        async up() {
          return { total: 0 };
        },
        async *both(inputs: AsyncIterable<{ n: number }>) {
          for await (const { n } of inputs) {
            yield { doubled: n * 2 };
          }
        },
      } as never,
      hostTransport
    );
    const client = Client.create(StreamService, clientTransport);

    async function* boths(): AsyncIterable<{ n: number }> {
      yield { n: 1 };
      yield { n: 2 };
      yield { n: 3 };
    }
    const items: unknown[] = [];
    for await (const item of client.both(boths())) {
      items.push(item);
    }
    expect(items).toEqual([{ doubled: 2 }, { doubled: 4 }, { doubled: 6 }]);

    const ep = endpointByName(await fetchStats(connection, 'stream-stats'), 'both');
    expect(ep.num_requests).toBe(1);
    expect(ep.num_errors).toBe(0);
    expect('last_error' in ep).toBe(false);

    await host.stop();
    await connection.close();
  });

  test('two separate serverStream calls count as TWO requests; average = total/2', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });
    const host = await Host.create(
      StreamService,
      {
        async *down(input: { n: number }) {
          for (let i = 0; i < input.n; i++) {
            yield { i };
          }
        },
        async up() {
          return { total: 0 };
        },
        async *both() {
          // no-op
        },
      } as never,
      hostTransport
    );
    const client = Client.create(StreamService, clientTransport);

    for (let call = 0; call < 2; call++) {
      for await (const _ of client.down({ n: 3 })) {
        // drain
      }
    }

    const ep = endpointByName(await fetchStats(connection, 'stream-stats'), 'down');
    expect(ep.num_requests).toBe(2);
    expect(ep.num_errors).toBe(0);
    expect(ep.processing_time).toBeGreaterThan(0);
    expect(ep.average_processing_time).toBe(Math.round(ep.processing_time / 2));

    await host.stop();
    await connection.close();
  });
});

// ===========================================================================
// processing_time measures open→close: a deliberately SLOW call accrues a
// duration that brackets the call wall-time, and it is recorded at CLOSE (not
// per frame). Exercised for each kind by holding the call open for a known
// minimum span.
// ===========================================================================
describe('streaming STATS — processing_time brackets the call wall-time (recorded at close)', () => {
  const SlowService = Contract.create('slow-stream', {
    version: '1.0.0',
    methods: {
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

  // A floor (ns) the slow call must comfortably exceed: the handler sleeps
  // SLEEP_MS, so the open→close span is at least ~that. We assert >= half of it
  // to stay robust against timer granularity while still proving it is NOT a
  // near-zero per-frame measurement.
  const SLEEP_MS = 120;
  const FLOOR_NS = (SLEEP_MS / 2) * 1_000_000;
  // A generous ceiling so a real call's ns duration is plausible (< 60s).
  const CEILING_NS = 60_000_000_000;

  test('serverStream: a slow call accrues processing_time bracketing the wall-time', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({
      connection,
      idleTimeout: 10_000,
    });
    const host = await Host.create(
      SlowService,
      {
        async *down() {
          // Yield one frame immediately, then hold the call open before closing.
          yield { i: 0 };
          await tick(SLEEP_MS);
          yield { i: 1 };
        },
        async up() {
          return { total: 0 };
        },
        async *both() {
          // no-op
        },
      } as never,
      hostTransport
    );
    const client = Client.create(SlowService, clientTransport);

    const start = Date.now();
    for await (const _ of client.down({ n: 0 })) {
      // drain
    }
    const wallMs = Date.now() - start;
    expect(wallMs).toBeGreaterThanOrEqual(SLEEP_MS - 30);

    const ep = endpointByName(await fetchStats(connection, 'slow-stream'), 'down');
    expect(ep.num_requests).toBe(1);
    // Recorded at CLOSE: the single call's duration brackets the slow handler.
    expect(ep.processing_time).toBeGreaterThan(FLOOR_NS);
    expect(ep.processing_time).toBeLessThan(CEILING_NS);

    await host.stop();
    await connection.close();
  });

  test('clientStream: a slow call accrues processing_time bracketing the wall-time', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({
      connection,
      idleTimeout: 10_000,
    });
    const host = await Host.create(
      SlowService,
      {
        async *down() {
          // no-op
        },
        async up(inputs: AsyncIterable<{ n: number }>) {
          let total = 0;
          for await (const { n } of inputs) {
            total += n;
          }
          // Hold the call open after consuming inputs, before the single output.
          await tick(SLEEP_MS);
          return { total };
        },
        async *both() {
          // no-op
        },
      } as never,
      hostTransport
    );
    const client = Client.create(SlowService, clientTransport);

    async function* ups(): AsyncIterable<{ n: number }> {
      yield { n: 7 };
    }
    expect(await client.up(ups())).toEqual({ total: 7 });

    const ep = endpointByName(await fetchStats(connection, 'slow-stream'), 'up');
    expect(ep.num_requests).toBe(1);
    expect(ep.processing_time).toBeGreaterThan(FLOOR_NS);
    expect(ep.processing_time).toBeLessThan(CEILING_NS);

    await host.stop();
    await connection.close();
  });

  test('duplex: a slow call accrues processing_time bracketing the wall-time', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({
      connection,
      idleTimeout: 10_000,
    });
    const host = await Host.create(
      SlowService,
      {
        async *down() {
          // no-op
        },
        async up() {
          return { total: 0 };
        },
        async *both(inputs: AsyncIterable<{ n: number }>) {
          for await (const { n } of inputs) {
            yield { doubled: n * 2 };
            await tick(SLEEP_MS);
          }
        },
      } as never,
      hostTransport
    );
    const client = Client.create(SlowService, clientTransport);

    async function* boths(): AsyncIterable<{ n: number }> {
      yield { n: 4 };
    }
    const items: unknown[] = [];
    for await (const item of client.both(boths())) {
      items.push(item);
    }
    expect(items).toEqual([{ doubled: 8 }]);

    const ep = endpointByName(await fetchStats(connection, 'slow-stream'), 'both');
    expect(ep.num_requests).toBe(1);
    expect(ep.processing_time).toBeGreaterThan(FLOOR_NS);
    expect(ep.processing_time).toBeLessThan(CEILING_NS);

    await host.stop();
    await connection.close();
  });
});

// ===========================================================================
// A call ending in an ErrorFrame increments num_errors + sets last_error; a
// graceful call does NOT. Exercised by a host handler that throws a declared
// contract error mid-stream (the host wrapper → ErrorFrame on the call).
// ===========================================================================
describe('streaming STATS — an ErrorFrame close is an error; a graceful close is not', () => {
  test('serverStream: a mid-stream throw (ErrorFrame) → num_errors += 1 and last_error; graceful call does not', async () => {
    const FailingService = Contract.create('err-down', {
      version: '1.0.0',
      methods: {
        watch: {
          kind: 'serverStream' as const,
          input: z.object({ fail: z.boolean() }),
          output: z.object({ event: z.string() }),
          errors: { StreamFailed: z.object({ reason: z.string() }) },
        },
      },
    });

    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });
    const host = await Host.create(
      FailingService,
      {
        async *watch(input: { fail: boolean }) {
          yield { event: 'one' };
          if (input.fail) {
            throw { _tag: 'StreamFailed', payload: { reason: 'boom' } };
          }
        },
      } as never,
      hostTransport
    );
    const client = Client.create(FailingService, clientTransport);

    // 1 graceful call (no error).
    for await (const _ of client.watch({ fail: false })) {
      // drain
    }
    // 1 failing call (ends in ErrorFrame).
    try {
      for await (const _ of client.watch({ fail: true })) {
        // drain
      }
    } catch {
      // expected ContractError
    }

    // Let the failing call's terminal/teardown settle so it is recorded.
    await tick(50);

    const ep = endpointByName(await fetchStats(connection, 'err-down'), 'watch');
    expect(ep.num_requests).toBe(2);
    expect(ep.num_errors).toBe(1);
    expect(ep.last_error).toContain('StreamFailed');

    await host.stop();
    await connection.close();
  });

  test('clientStream: a handler throw (ErrorFrame) → num_errors += 1 and last_error', async () => {
    const FailingService = Contract.create('err-up', {
      version: '1.0.0',
      methods: {
        collect: {
          kind: 'clientStream' as const,
          input: z.object({ n: z.number() }),
          output: z.object({ total: z.number() }),
          errors: { Rejected: z.object({ why: z.string() }) },
        },
      },
    });

    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });
    const host = await Host.create(
      FailingService,
      {
        async collect(inputs: AsyncIterable<{ n: number }>) {
          for await (const _ of inputs) {
            // consume then reject
          }
          throw { _tag: 'Rejected', payload: { why: 'nope' } };
        },
      } as never,
      hostTransport
    );
    const client = Client.create(FailingService, clientTransport);

    async function* ups(): AsyncIterable<{ n: number }> {
      yield { n: 1 };
      yield { n: 2 };
    }
    let threw = false;
    try {
      await client.collect(ups());
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    await tick(50);

    const ep = endpointByName(await fetchStats(connection, 'err-up'), 'collect');
    expect(ep.num_requests).toBe(1);
    expect(ep.num_errors).toBe(1);
    expect(ep.last_error).toContain('Rejected');

    await host.stop();
    await connection.close();
  });

  test('duplex: a handler throw (ErrorFrame) → num_errors += 1 and last_error', async () => {
    const FailingService = Contract.create('err-both', {
      version: '1.0.0',
      methods: {
        echo: {
          kind: 'duplex' as const,
          input: z.object({ msg: z.string() }),
          output: z.object({ reply: z.string() }),
          errors: { Boom: z.object({ at: z.string() }) },
        },
      },
    });

    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });
    const host = await Host.create(
      FailingService,
      {
        async *echo(inputs: AsyncIterable<{ msg: string }>) {
          for await (const { msg } of inputs) {
            yield { reply: `echo:${msg}` };
            throw { _tag: 'Boom', payload: { at: msg } };
          }
        },
      } as never,
      hostTransport
    );
    const client = Client.create(FailingService, clientTransport);

    async function* inputs(): AsyncIterable<{ msg: string }> {
      yield { msg: 'hi' };
      await tick(200);
    }
    const received: unknown[] = [];
    try {
      for await (const item of client.echo(inputs())) {
        received.push(item);
      }
    } catch {
      // expected
    }
    expect(received).toEqual([{ reply: 'echo:hi' }]);

    await tick(50);

    const ep = endpointByName(await fetchStats(connection, 'err-both'), 'echo');
    expect(ep.num_requests).toBe(1);
    expect(ep.num_errors).toBe(1);
    expect(ep.last_error).toContain('Boom');

    await host.stop();
    await connection.close();
  });
});

// ===========================================================================
// A call ending in a CancelFrame (client abort) increments num_errors + sets
// last_error. Driven with a raw client that opens a call then sends a
// CancelFrame on `up`, for each kind that subscribes `up`.
// ===========================================================================
describe('streaming STATS — a CancelFrame close is an error', () => {
  /**
   * Open a streaming call with a raw client (no real Client needed) and send a
   * CancelFrame on `up` after the host has produced/parked, then unblock teardown.
   * Drains `down` so the host can publish.
   */
  async function openThenCancel(
    connection: NatsConnection,
    subject: string,
    options?: { sendOpenInput?: unknown }
  ): Promise<void> {
    const down = `_INBOX.cancel.down.${Math.random().toString(36).slice(2)}`;
    const up = `_INBOX.cancel.up.${Math.random().toString(36).slice(2)}`;
    const downSub = connection.subscribe(down);
    void (async () => {
      for await (const _ of downSub) {
        // drain down frames; don't replenish credit, so the host parks
      }
    })();
    connection.publish(
      subject,
      serde.encode({ up, down, credit: 2, input: options?.sendOpenInput }),
      { reply: down }
    );
    // Let the host receive the open, subscribe `up`, and produce up to credit.
    await tick(120);
    // Client aborts the whole call.
    connection.publish(up, serde.encode({ t: 'a', reason: 'client-abort' }));
    await tick(150);
    downSub.unsubscribe();
  }

  test('serverStream: a client CancelFrame → num_errors += 1 and last_error', async () => {
    const connection = await server.connect();
    const host = new NatsHostTransport({ connection, idleTimeout: 10_000 });
    const unregister = await host.register({
      service: 'cancel-down',
      methods: [
        {
          method: 'watch',
          kind: 'serverStream',
          handler: async function* (): AsyncIterable<HostResponse> {
            for (let i = 0; i < 1000; i++) {
              yield { output: { event: 'x', seq: i } };
            }
          },
        },
      ],
    });

    await openThenCancel(connection, 'rpc.cancel-down.watch');

    const ep = endpointByName(await fetchStats(connection, 'cancel-down'), 'watch');
    expect(ep.num_requests).toBe(1);
    expect(ep.num_errors).toBe(1);
    expect(typeof ep.last_error).toBe('string');

    await unregister();
    await connection.close();
  });

  test('clientStream: a client CancelFrame → num_errors += 1 and last_error', async () => {
    const connection = await server.connect();
    const host = new NatsHostTransport({ connection, idleTimeout: 10_000 });
    const unregister = await host.register({
      service: 'cancel-up',
      methods: [
        {
          method: 'collect',
          kind: 'clientStream',
          handler: async function (
            _req: unknown,
            inputs: AsyncIterable<unknown>
          ): Promise<HostResponse> {
            for await (const _ of inputs) {
              // consume
            }
            return { output: { total: 0 } };
          } as never,
        },
      ],
    });

    await openThenCancel(connection, 'rpc.cancel-up.collect');

    const ep = endpointByName(await fetchStats(connection, 'cancel-up'), 'collect');
    expect(ep.num_requests).toBe(1);
    expect(ep.num_errors).toBe(1);
    expect(typeof ep.last_error).toBe('string');

    await unregister();
    await connection.close();
  });

  test('duplex: a client CancelFrame → num_errors += 1 and last_error', async () => {
    const connection = await server.connect();
    const host = new NatsHostTransport({ connection, idleTimeout: 10_000 });
    const unregister = await host.register({
      service: 'cancel-both',
      methods: [
        {
          method: 'echo',
          kind: 'duplex',
          handler: async function* (
            _req: unknown,
            inputs: AsyncIterable<{ n?: number }>
          ): AsyncIterable<HostResponse> {
            for await (const _ of inputs) {
              for (let i = 0; i < 1000; i++) {
                yield { output: { doubled: i } };
              }
            }
          } as never,
        },
      ],
    });

    // Send an input so the duplex handler starts producing, then cancel.
    const down = `_INBOX.cb.down.${Math.random().toString(36).slice(2)}`;
    const up = `_INBOX.cb.up.${Math.random().toString(36).slice(2)}`;
    const downSub = connection.subscribe(down);
    void (async () => {
      for await (const _ of downSub) {
        // drain
      }
    })();
    connection.publish('rpc.cancel-both.echo', serde.encode({ up, down, credit: 2 }), {
      reply: down,
    });
    await tick(100);
    connection.publish(up, serde.encode({ t: 'd', seq: 0, data: { n: 1 } }));
    await tick(100);
    connection.publish(up, serde.encode({ t: 'a', reason: 'client-abort' }));
    await tick(150);
    downSub.unsubscribe();

    const ep = endpointByName(await fetchStats(connection, 'cancel-both'), 'echo');
    expect(ep.num_requests).toBe(1);
    expect(ep.num_errors).toBe(1);
    expect(typeof ep.last_error).toBe('string');

    await unregister();
    await connection.close();
  });
});

// ===========================================================================
// A call ending in a host-side idle timeout (__timeout__) increments
// num_errors + sets last_error (clientStream: a silent client trips the host
// idle timer).
// ===========================================================================
describe('streaming STATS — a host idle timeout close is an error', () => {
  test('clientStream: a silent client → host __timeout__ → num_errors += 1 and last_error', async () => {
    const connection = await server.connect();
    const host = new NatsHostTransport({ connection, idleTimeout: 60 });
    const unregister = await host.register({
      service: 'timeout-up',
      methods: [
        {
          method: 'collect',
          kind: 'clientStream',
          handler: async function (
            _req: unknown,
            inputs: AsyncIterable<unknown>
          ): Promise<HostResponse> {
            for await (const _ of inputs) {
              // consume
            }
            return { output: { total: 0 } };
          } as never,
        },
      ],
    });

    // Raw client: open then go SILENT on `up`; the host idle timer fires.
    const down = `_INBOX.to.down.${Math.random().toString(36).slice(2)}`;
    const up = `_INBOX.to.up.${Math.random().toString(36).slice(2)}`;
    const downSub = connection.subscribe(down);
    const sawTerminal = (async (): Promise<void> => {
      for await (const msg of downSub) {
        const frame = serde.decode(msg.data) as { t?: string };
        if (frame.t === 'x') {
          return;
        }
      }
    })();
    connection.publish('rpc.timeout-up.collect', serde.encode({ up, down, credit: 8 }), {
      reply: down,
    });
    await Promise.race([sawTerminal, tick(1000)]);
    // Allow the host's finally/record to run.
    await tick(50);
    downSub.unsubscribe();

    const ep = endpointByName(await fetchStats(connection, 'timeout-up'), 'collect');
    expect(ep.num_requests).toBe(1);
    expect(ep.num_errors).toBe(1);
    expect(ep.last_error).toContain('__timeout__');

    await unregister();
    await connection.close();
  });
});
