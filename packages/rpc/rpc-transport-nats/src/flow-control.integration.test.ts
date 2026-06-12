import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { Client } from '@insler/rpc/client';
import { Contract } from '@insler/rpc/contract';
import { Host } from '@insler/rpc/host';
import { createMemoryTransport } from '@insler/rpc/transport-memory';
import { z } from 'zod';

import { createNatsTransport } from './index.js';
import { type EphemeralNatsServer, startEphemeralNatsServer } from './nats-test-harness.js';

// --------------------------------------------------------------------------
// serverStream credit-based flow control over NATS (issue 0005, ADR-0001 §2.5).
//
// The "no unbounded buffering" guarantee: with a deliberately SLOW consumer and
// a SMALL credit window, the number of DataFrames the host has produced but the
// client has not yet consumed stays bounded by the window. The host pauses at
// credit 0 and resumes only as the client consumes items (which replenishes
// credit). Asserted against a REAL nats-server, and shown to match
// transport-memory's observable streaming result under the same backpressure.
// --------------------------------------------------------------------------

let server: EphemeralNatsServer;

beforeAll(async () => {
  server = await startEphemeralNatsServer();
});

afterAll(async () => {
  await server.stop();
});

const TICKS = 20;
const CREDIT = 3;

const CounterService = Contract.create('counter', {
  version: '1.0.0',
  methods: {
    count: {
      kind: 'serverStream' as const,
      input: z.object({ to: z.number() }),
      output: z.object({ n: z.number() }),
    },
  },
});

describe('serverStream flow control over NATS — bounded in-flight window', () => {
  test('a slow consumer bounds host-produced-but-unconsumed DataFrames to the credit window', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({
      connection,
      // Small window so the bound is observable.
      credit: CREDIT,
    });

    // The host handler records how many items it has PRODUCED (each generator
    // step is one output the transport will publish once credit allows). With
    // backpressure wired, the handler cannot run arbitrarily far ahead of the
    // consumer: production is gated by the sender's credit window.
    let produced = 0;
    const host = await Host.create(
      CounterService,
      {
        async *count(input: { to: number }) {
          for (let n = 0; n < input.to; n++) {
            produced = n + 1;
            yield { n };
          }
        },
      } as never,
      hostTransport
    );

    const client = Client.create(CounterService, clientTransport);
    const consumed: number[] = [];
    let maxInFlight = 0;

    for await (const item of client.count({ to: TICKS })) {
      const value = (item as { n: number }).n;
      consumed.push(value);
      // Slow consumer: pause on every item so the host would race ahead without
      // backpressure. The gap between produced and consumed is the in-flight
      // window; it must never exceed the credit (+ the one item currently being
      // consumed before its replenishing CreditFrame lands).
      const inFlight = produced - consumed.length;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
    }

    // All items arrived, in order.
    expect(consumed).toEqual(Array.from({ length: TICKS }, (_, i) => i));
    // The host produced exactly the stream length (it did run to completion)...
    expect(produced).toBe(TICKS);
    // ...but never ran more than ~one window ahead of the consumer. Without
    // flow control, produced would jump to TICKS almost immediately and
    // maxInFlight would approach TICKS. A small constant bound proves the host
    // paused at credit 0 and resumed only as the client consumed.
    expect(maxInFlight).toBeLessThanOrEqual(CREDIT + 1);

    await host.stop();
    await connection.close();
  });

  test('the sender resumes after pausing — a stream longer than the window completes', async () => {
    // If credit were never replenished, the host would pause permanently after
    // the first `credit` DataFrames and the stream would hang. Completing a
    // stream many times longer than the window proves resume-on-CreditFrame.
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({
      connection,
      credit: 2,
    });

    const host = await Host.create(
      CounterService,
      {
        async *count(input: { to: number }) {
          for (let n = 0; n < input.to; n++) {
            yield { n };
          }
        },
      } as never,
      hostTransport
    );

    const client = Client.create(CounterService, clientTransport);
    const consumed: number[] = [];
    for await (const item of client.count({ to: 50 })) {
      consumed.push((item as { n: number }).n);
    }

    expect(consumed).toEqual(Array.from({ length: 50 }, (_, i) => i));

    await host.stop();
    await connection.close();
  });
});

describe('serverStream flow control over NATS — parity with transport-memory', () => {
  test('same observable streaming result under a slow consumer (memory vs NATS)', async () => {
    const handlers = {
      async *count(input: { to: number }) {
        for (let n = 0; n < input.to; n++) {
          yield { n: n * 2 };
        }
      },
    } as never;

    const slowlyConsume = async (stream: AsyncIterable<unknown>): Promise<Array<{ n: number }>> => {
      const out: Array<{ n: number }> = [];
      for await (const item of stream) {
        out.push(item as { n: number });
        await new Promise((r) => setTimeout(r, 5));
      }
      return out;
    };

    // transport-memory: the canonical observable result under a slow consumer.
    const memoryTransport = createMemoryTransport();
    const memoryHost = await Host.create(CounterService, handlers, memoryTransport.host);
    const memoryClient = Client.create(CounterService, memoryTransport.client);
    const memoryResult = await slowlyConsume(memoryClient.count({ to: 12 }));
    await memoryHost.stop();

    // NATS with a small credit window under the same slow consumer.
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({
      connection,
      credit: CREDIT,
    });
    const natsHost = await Host.create(CounterService, handlers, hostTransport);
    const natsClient = Client.create(CounterService, clientTransport);
    const natsResult = await slowlyConsume(natsClient.count({ to: 12 }));
    await natsHost.stop();
    await connection.close();

    // Same observable streaming result on both transports under backpressure.
    expect(natsResult).toEqual(memoryResult);
    expect(natsResult).toEqual(Array.from({ length: 12 }, (_, i) => ({ n: i * 2 })));
  });
});
