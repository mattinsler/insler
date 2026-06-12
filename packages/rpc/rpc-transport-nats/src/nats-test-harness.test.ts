import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { Client } from '@insler/rpc/client';
import { Contract } from '@insler/rpc/contract';
import { Host } from '@insler/rpc/host';
import type { NatsConnection } from '@nats-io/transport-node';
import { z } from 'zod';

import { createNatsTransport } from './index.js';
import { startEphemeralNatsServer, type EphemeralNatsServer } from './nats-test-harness.js';

// These tests exercise a REAL nats-server. The binary is provisioned via mise
// (pinned in mise.toml [tools]; resolves on PATH). If it is not on PATH the
// harness throws — which is the correct, loud failure, not a silent skip.

// --------------------------------------------------------------------------
// AC1 / AC2: spawn on loopback w/ random port, core NATS only, port via ports file
// --------------------------------------------------------------------------

describe('startEphemeralNatsServer', () => {
  let server: EphemeralNatsServer;

  beforeAll(async () => {
    server = await startEphemeralNatsServer();
  });

  afterAll(async () => {
    await server.stop();
  });

  test('AC1: binds loopback with a random (non-zero, non-default) port', () => {
    expect(server.port).toBeGreaterThan(0);
    // -p -1 means a random ephemeral port, never the NATS default 4222.
    expect(server.port).not.toBe(4222);
    expect(server.url).toBe(`nats://127.0.0.1:${server.port}`);
  });

  test('AC2: the URL resolved from the ports file accepts a real connection', async () => {
    // A connection succeeding proves the port we resolved (deterministically,
    // from the ports file) is the actual port the server bound to.
    const connection = await server.connect();
    expect(connection.isClosed()).toBe(false);
    await connection.close();
  });

  test('AC1: server answers core-NATS pub/sub (no JetStream needed)', async () => {
    const connection = await server.connect();
    const sub = connection.subscribe('harness.ping');

    const received: string[] = [];
    const done = (async () => {
      for await (const msg of sub) {
        received.push(msg.string());
        break;
      }
    })();

    connection.publish('harness.ping', new TextEncoder().encode('pong'));
    await connection.flush();
    await done;

    expect(received).toEqual(['pong']);
    await connection.close();
  });
});

// --------------------------------------------------------------------------
// AC3: killed and awaited in teardown; no lingering server / port freed
// --------------------------------------------------------------------------

describe('startEphemeralNatsServer teardown', () => {
  test('AC3: stop() kills the server so its port stops accepting connections', async () => {
    const server = await startEphemeralNatsServer();
    const { port } = server;

    // Server is up: a connection works before teardown.
    const connection = await server.connect();
    expect(connection.isClosed()).toBe(false);
    await connection.close();

    await server.stop();

    // After teardown the server is gone: nothing answers on that port anymore.
    await expect(connectOnce(`nats://127.0.0.1:${port}`)).rejects.toBeDefined();
  });

  test('AC3: stop() is idempotent (safe to call from afterAll/afterEach twice)', async () => {
    const server = await startEphemeralNatsServer();
    await server.stop();
    await expect(server.stop()).resolves.toBeUndefined();
  });

  test('AC3: no nats-server process lingers on the harness port after stop()', async () => {
    const server = await startEphemeralNatsServer();
    const { port } = server;
    await server.stop();

    // Ask the OS directly: nothing should be listening on the port we used.
    const listeners = await Bun.$`lsof -nP -iTCP:${port} -sTCP:LISTEN`.quiet().nothrow().text();
    expect(listeners.trim()).toBe('');
  });
});

// --------------------------------------------------------------------------
// AC4: unary RPC round-trip over the REAL server via createNatsTransport,
//      using the real @insler contract / host / client (not mocks).
// --------------------------------------------------------------------------

const EchoContract = Contract.create('echo-service', {
  version: '1.0.0',
  methods: {
    echo: {
      input: z.object({ message: z.string() }),
      output: z.object({ message: z.string() }),
    },
    add: {
      input: z.object({ a: z.number(), b: z.number() }),
      output: z.object({ sum: z.number() }),
    },
  },
});

describe('smoke: unary RPC round-trip over real nats-server', () => {
  let server: EphemeralNatsServer;
  let connection: NatsConnection;
  let stop: () => Promise<void>;
  let smokeClient: Contract.Client<typeof EchoContract>;

  beforeAll(async () => {
    server = await startEphemeralNatsServer();
    connection = await server.connect();

    const transport = createNatsTransport({ connection, queue: 'q' });

    const host = await Host.create(
      EchoContract,
      {
        echo: async (input: { message: string }) => ({ message: input.message }),
        add: async (input: { a: number; b: number }) => ({ sum: input.a + input.b }),
      } as never,
      transport.host
    );

    const client = Client.create(EchoContract, transport.client);
    stop = host.stop.bind(host);

    smokeClient = client;
  });

  afterAll(async () => {
    await stop();
    await connection.close();
    await server.stop();
  });

  test('AC4: client.echo round-trips through the real server', async () => {
    const result = await smokeClient.echo({ message: 'hello over the wire' });
    expect(result).toEqual({ message: 'hello over the wire' });
  });

  test('AC4: a second method round-trips on the same connection', async () => {
    const result = await smokeClient.add({ a: 19, b: 23 });
    expect(result).toEqual({ sum: 42 });
  });
});

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Connect once with a short timeout and no reconnect, then close. Rejects if
 * nothing is listening. Used to assert a stopped server's port is dead. */
async function connectOnce(url: string): Promise<void> {
  const { connect } = await import('@nats-io/transport-node');
  const connection = await connect({
    servers: url,
    maxReconnectAttempts: 0,
    timeout: 1_000,
  });
  await connection.close();
}
