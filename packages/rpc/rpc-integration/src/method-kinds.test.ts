import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { createNatsTransport } from '@insler/rpc-transport-nats';
import { Client, ContractError } from '@insler/rpc/client';
import { Contract } from '@insler/rpc/contract';
import { Host } from '@insler/rpc/host';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import { z } from 'zod';

import { type EphemeralNatsServer, startNatsServer } from './nats-server.js';

// All four method kinds end-to-end over a REAL nats-server (subsystem-branding
// issue 0006): ONE contract mixing unary + serverStream + clientStream +
// duplex, served by one Host.create registration and called through the typed
// client — public umbrella entrypoints + the NATS adapter package only,
// exactly as an external consumer composes them. The transport's unit suites
// prove the same wire behaviors in-repo; this suite re-proves them as
// installed (built dist). Assertions are what the consumer observes: yielded
// items, completion, context propagation, and typed errors — never frames or
// other internals.

const telemetry = Contract.create('telemetry', {
  version: '1.0.0',
  context: { identity: z.object({ userId: z.string() }) },
  methods: {
    // unary
    report: {
      input: z.object({ probe: z.string(), value: z.number() }),
      output: z.object({ accepted: z.boolean(), by: z.string() }),
    },
    // serverStream — with a declared mid-stream error
    watch: {
      kind: 'serverStream',
      input: z.object({ probe: z.string(), count: z.number().int() }),
      output: z.object({ probe: z.string(), reading: z.number(), by: z.string() }),
      errors: { ProbeOffline: z.object({ probe: z.string() }) },
    },
    // clientStream
    upload: {
      kind: 'clientStream',
      input: z.object({ value: z.number() }),
      output: z.object({ count: z.number(), total: z.number(), by: z.string() }),
    },
    // duplex
    mirror: {
      kind: 'duplex',
      input: z.object({ value: z.number() }),
      output: z.object({ doubled: z.number(), by: z.string() }),
    },
  },
});

const handlers: Contract.Handlers<typeof telemetry> = {
  report: async (context, { probe }) => ({
    accepted: probe.length > 0,
    by: context.identity.userId,
  }),

  watch: async function* (context, { probe, count }) {
    if (probe === 'offline-probe') {
      yield { probe, reading: 1, by: context.identity.userId };
      throw { _tag: 'ProbeOffline', payload: { probe } };
    }
    for (let i = 1; i <= count; i += 1) {
      yield { probe, reading: i * 10, by: context.identity.userId };
    }
  },

  upload: async (context, inputStream) => {
    let count = 0;
    let total = 0;
    for await (const { value } of inputStream) {
      count += 1;
      total += value;
    }
    return { count, total, by: context.identity.userId };
  },

  mirror: async function* (context, inputStream) {
    for await (const { value } of inputStream) {
      yield { doubled: value * 2, by: context.identity.userId };
    }
  },
};

let server: EphemeralNatsServer;
let connection: NatsConnection;
let host: { stop(): Promise<void> };

beforeAll(async () => {
  server = await startNatsServer();
  connection = await connect({ servers: server.url });
  const transport = createNatsTransport({ connection });
  host = await Host.create(telemetry, handlers, transport.host);
});

afterAll(async () => {
  await host?.stop();
  await connection?.close();
  await server?.stop();
});

function createClient(userId = 'u_42'): Contract.ScopedClient<typeof telemetry> {
  const transport = createNatsTransport({ connection });
  return Client.withContext(Client.create(telemetry, transport.client), {
    identity: { userId },
  });
}

describe('all four method kinds over a real NATS server', () => {
  test('unary: a call on the mixed-kind contract round-trips with context', async () => {
    const client = createClient();
    await expect(client.report({ probe: 'p-1', value: 7 })).resolves.toEqual({
      accepted: true,
      by: 'u_42',
    });
  });

  test('serverStream: the client iterates every yielded item in order, then the stream completes', async () => {
    const client = createClient();

    const items: unknown[] = [];
    for await (const item of client.watch({ probe: 'p-2', count: 3 })) {
      items.push(item);
    }

    // The for-await loop exiting IS the completion signal a consumer observes.
    expect(items).toEqual([
      { probe: 'p-2', reading: 10, by: 'u_42' },
      { probe: 'p-2', reading: 20, by: 'u_42' },
      { probe: 'p-2', reading: 30, by: 'u_42' },
    ]);
  });

  test('serverStream: a declared mid-stream error surfaces as the typed ContractError; prior items remain delivered', async () => {
    const client = createClient();

    const items: unknown[] = [];
    let thrown: unknown;
    try {
      for await (const item of client.watch({ probe: 'offline-probe', count: 5 })) {
        items.push(item);
      }
    } catch (err) {
      thrown = err;
    }

    expect(items).toEqual([{ probe: 'offline-probe', reading: 1, by: 'u_42' }]);
    expect(thrown).toBeInstanceOf(ContractError);
    expect((thrown as ContractError)._tag).toBe('ProbeOffline');
    expect((thrown as ContractError).payload).toEqual({ probe: 'offline-probe' });
  });

  test('clientStream: the host consumes the streamed inputs and replies once', async () => {
    const client = createClient('u_uploader');

    async function* readings(): AsyncIterable<{ value: number }> {
      yield { value: 1 };
      yield { value: 2 };
      yield { value: 3 };
      yield { value: 4 };
    }

    await expect(client.upload(readings())).resolves.toEqual({
      count: 4,
      total: 10,
      by: 'u_uploader',
    });
  });

  test('duplex: each streamed input is transformed into an output, in order, and both directions complete', async () => {
    const client = createClient('u_mirror');

    async function* values(): AsyncIterable<{ value: number }> {
      yield { value: 3 };
      yield { value: 5 };
      yield { value: 8 };
    }

    const items: unknown[] = [];
    for await (const item of client.mirror(values())) {
      items.push(item);
    }

    expect(items).toEqual([
      { doubled: 6, by: 'u_mirror' },
      { doubled: 10, by: 'u_mirror' },
      { doubled: 16, by: 'u_mirror' },
    ]);
  });
});
