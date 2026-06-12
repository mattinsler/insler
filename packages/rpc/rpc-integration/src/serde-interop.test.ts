import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { createNatsTransport } from '@insler/rpc-transport-nats';
import { Client } from '@insler/rpc/client';
import { Contract } from '@insler/rpc/contract';
import { Host } from '@insler/rpc/host';
import { cborSerde } from '@insler/serde-cbor';
import { jsonBytesSerde } from '@insler/serde-json';
import { msgpackSerde } from '@insler/serde-msgpack';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import { z } from 'zod';

import { type EphemeralNatsServer, startNatsServer } from './nats-server.js';

// Serde adapter interop over a REAL nats-server (subsystem-branding issue
// 0006): the published serde adapters plugged into the rpc subsystem's public
// configuration point — `createNatsTransport({ serde })`, a `Serde<Uint8Array>`
// — with both sides configured the way a consumer deploys them. Each adapter
// round-trips a unary call AND a duplex stream (frames in both directions ride
// the injected encoder), through built dist of the public packages only.
// Assertions are the values the consumer gets back, never wire bytes.

const Echo = Contract.create('serde-echo', {
  version: '1.0.0',
  methods: {
    echo: {
      input: z.object({
        text: z.string(),
        n: z.number(),
        flag: z.boolean(),
        list: z.array(z.number()),
        nested: z.object({ inner: z.string() }),
      }),
      output: z.object({
        text: z.string(),
        n: z.number(),
        flag: z.boolean(),
        list: z.array(z.number()),
        nested: z.object({ inner: z.string() }),
      }),
    },
    relay: {
      kind: 'duplex',
      input: z.object({ msg: z.string(), seq: z.number() }),
      output: z.object({ msg: z.string(), seq: z.number() }),
    },
  },
});

const echoHandlers: Contract.Handlers<typeof Echo> = {
  echo: async (input) => input,
  relay: async function* (inputStream) {
    for await (const item of inputStream) {
      yield { msg: `relay:${item.msg}`, seq: item.seq };
    }
  },
};

// A payload exercising strings (incl. non-ASCII), floats, booleans, arrays,
// and nesting — shapes every adapter must round-trip identically.
const payload = {
  text: 'héllo wörld ✓',
  n: 1234.5625,
  flag: true,
  list: [1, 2.5, -3],
  nested: { inner: 'deep value' },
};

let server: EphemeralNatsServer;
let connection: NatsConnection;

beforeAll(async () => {
  server = await startNatsServer();
  connection = await connect({ servers: server.url });
});

afterAll(async () => {
  await connection?.close();
  await server?.stop();
});

// Each published Serde<Uint8Array> adapter a consumer can hand the transport.
const adapters = [
  ['@insler/serde-json jsonBytesSerde (the default lineage, explicit)', jsonBytesSerde],
  ['@insler/serde-cbor cborSerde', cborSerde],
  ['@insler/serde-msgpack msgpackSerde', msgpackSerde],
] as const;

describe.each(adapters)('serde interop over a real NATS server — %s', (_name, serde) => {
  test('a unary call round-trips a structured payload through the adapter', async () => {
    const { client: clientTransport, host: hostTransport } = createNatsTransport({
      connection,
      serde,
    });
    const host = await Host.create(Echo, echoHandlers, hostTransport);
    const client = Client.create(Echo, clientTransport);

    try {
      await expect(client.echo(payload)).resolves.toEqual(payload);
    } finally {
      await host.stop();
    }
  });

  test('a duplex stream rides the adapter in both directions', async () => {
    const { client: clientTransport, host: hostTransport } = createNatsTransport({
      connection,
      serde,
    });
    const host = await Host.create(Echo, echoHandlers, hostTransport);
    const client = Client.create(Echo, clientTransport);

    async function* inputs(): AsyncIterable<{ msg: string; seq: number }> {
      yield { msg: 'à-1', seq: 1 };
      yield { msg: 'b-2', seq: 2 };
    }

    try {
      const items: unknown[] = [];
      for await (const item of client.relay(inputs())) {
        items.push(item);
      }
      expect(items).toEqual([
        { msg: 'relay:à-1', seq: 1 },
        { msg: 'relay:b-2', seq: 2 },
      ]);
    } finally {
      await host.stop();
    }
  });
});

describe('serde interop — rich-type fidelity of the JSON adapter', () => {
  // @insler/serde-json is SuperJSON-backed: types plain JSON cannot carry
  // (here Date, validated by the contract's z.date()) survive the real wire.
  const Clock = Contract.create('serde-clock', {
    version: '1.0.0',
    methods: {
      after: {
        input: z.object({ at: z.date(), days: z.number().int() }),
        output: z.object({ at: z.date() }),
      },
    },
  });

  test('a Date round-trips as a Date through @insler/serde-json over the wire', async () => {
    const { client: clientTransport, host: hostTransport } = createNatsTransport({
      connection,
      serde: jsonBytesSerde,
    });
    const host = await Host.create(
      Clock,
      {
        after: async ({ at, days }) => ({ at: new Date(at.getTime() + days * 86_400_000) }),
      },
      hostTransport
    );
    const client = Client.create(Clock, clientTransport);

    try {
      const sent = new Date('2026-06-11T12:00:00.000Z');
      const { at } = await client.after({ at: sent, days: 2 });
      expect(at).toBeInstanceOf(Date);
      expect(at.toISOString()).toBe('2026-06-13T12:00:00.000Z');
    } finally {
      await host.stop();
    }
  });
});
