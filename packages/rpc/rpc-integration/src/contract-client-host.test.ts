import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { createNatsTransport } from '@insler/rpc-transport-nats';
import { Client, ContractError } from '@insler/rpc/client';
import { Contract } from '@insler/rpc/contract';
import { Host } from '@insler/rpc/host';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import { z } from 'zod';

import { type EphemeralNatsServer, startNatsServer } from './nats-server.js';

// The rpc subsystem's tracer-bullet integration test (subsystem-branding
// issue 0005): contract + client + host end-to-end over a REAL nats-server
// (provisioned by the mise toolchain, started/stopped by this suite),
// consuming the subsystem exactly as an external consumer would — public
// umbrella entrypoints + the NATS adapter package, resolved to built dist
// output (run `bun run build` first). Issue 0006 grows the suite on these
// rails (all four method kinds, serde interop, the discovery plane).

const calculator = Contract.create('calculator', {
  version: '1.0.0',
  context: { identity: z.object({ userId: z.string() }) },
  methods: {
    add: {
      input: z.object({ a: z.number(), b: z.number() }),
      output: z.object({ sum: z.number(), by: z.string() }),
    },
    divide: {
      input: z.object({ dividend: z.number(), divisor: z.number() }),
      output: z.object({ quotient: z.number() }),
      errors: { DivideByZero: z.object({ dividend: z.number() }) },
    },
  },
});

const handlers: Contract.Handlers<typeof calculator> = {
  add: async (context, { a, b }) => ({ sum: a + b, by: context.identity.userId }),
  divide: async (_context, { dividend, divisor }) => {
    if (divisor === 0) throw { _tag: 'DivideByZero', payload: { dividend } };
    return { quotient: dividend / divisor };
  },
};

let server: EphemeralNatsServer;
let connection: NatsConnection;
let host: { stop(): Promise<void> };

beforeAll(async () => {
  server = await startNatsServer();
  connection = await connect({ servers: server.url });
  const transport = createNatsTransport({ connection });
  host = await Host.create(calculator, handlers, transport.host);
});

afterAll(async () => {
  await host?.stop();
  await connection?.close();
  await server?.stop();
});

function createClient(): Contract.ScopedClient<typeof calculator> {
  const transport = createNatsTransport({ connection });
  return Client.withContext(Client.create(calculator, transport.client), {
    identity: { userId: 'u_1' },
  });
}

describe('contract + client + host over a real NATS server', () => {
  test('a unary call round-trips through validation, context propagation, and the wire', async () => {
    const client = createClient();
    await expect(client.add({ a: 19, b: 23 })).resolves.toEqual({ sum: 42, by: 'u_1' });
  });

  test('a typed contract error rides the wire and surfaces as a ContractError', async () => {
    const client = createClient();
    const error = await client.divide({ dividend: 7, divisor: 0 }).then(
      () => {
        throw new Error('expected divide to reject');
      },
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError)._tag).toBe('DivideByZero');
    expect((error as ContractError).payload).toEqual({ dividend: 7 });
  });

  test('host-side input validation rejects a wire payload the contract forbids', async () => {
    const client = createClient();
    // Defeat the client-side types the way a mis-typed external consumer
    // would, so the *host's* zod validation is what rejects the call.
    const dishonest = client as unknown as {
      add(input: { a: string; b: number }): Promise<unknown>;
    };
    const error = await dishonest.add({ a: 'one', b: 2 }).then(
      () => {
        throw new Error('expected add to reject');
      },
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError)._tag).toBe('__validation__');
  });
});
