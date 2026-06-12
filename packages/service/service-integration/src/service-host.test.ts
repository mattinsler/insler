import { describe, expect, test } from 'bun:test';

import { Client, ContractError } from '@insler/rpc/client';
import { Contract } from '@insler/rpc/contract';
import { createMemoryTransport } from '@insler/rpc/transport-memory';
import { Service } from '@insler/service';
import { z } from 'zod';

// The env-aware runtime role of @insler/service, exercised consumer-grade
// (subsystem-branding issue 0009): a contract authored with the rpc core,
// served via Service.create over an injected transport, called with a plain
// rpc client — all through the published surface, against built dist output.
// The transport is the consumer's choice; in-memory keeps the suite
// infrastructure-free (the wire-level NATS seam is rpc-integration's).

const GreeterContract = Contract.create('greeter', {
  version: '1.0.0',
  methods: {
    greet: {
      input: z.object({ name: z.string() }),
      output: z.object({ message: z.string() }),
    },
    fail: {
      input: z.object({ id: z.string() }),
      output: z.object({ ok: z.boolean() }),
      errors: {
        NotFound: z.object({ id: z.string() }),
      },
    },
  },
});

const handlers: Contract.Handlers<typeof GreeterContract> = {
  greet: async (input) => ({ message: `Hello, ${input.name}!` }),
  fail: async (input) => {
    throw { _tag: 'NotFound', payload: { id: input.id } };
  },
};

describe('Service.create as a consumer', () => {
  test('serves a real contract end-to-end over an injected transport', async () => {
    const transport = createMemoryTransport();
    const service = await Service.create(GreeterContract, handlers, transport.host);

    const client = Client.create(GreeterContract, transport.client);
    expect(await client.greet({ name: 'Ada' })).toEqual({ message: 'Hello, Ada!' });

    await service.stop();
  });

  test('detects the test environment automatically under a test runner', async () => {
    const transport = createMemoryTransport();
    const service = await Service.create(GreeterContract, handlers, transport.host);

    expect(service.env).toBe('test');

    await service.stop();
  });

  test('the env option overrides detection (the documented escape hatch)', async () => {
    const transport = createMemoryTransport();
    const service = await Service.create(GreeterContract, handlers, transport.host, {
      env: 'production',
    });

    expect(service.env).toBe('production');

    await service.stop();
  });

  test('validates handler completeness in non-production environments', async () => {
    const transport = createMemoryTransport();
    const incomplete = { greet: handlers.greet } as Contract.Handlers<typeof GreeterContract>;

    await expect(Service.create(GreeterContract, incomplete, transport.host)).rejects.toThrow(
      /Missing handlers.*fail/
    );
  });

  test('production mode serves the contract without dev policy in the way', async () => {
    const transport = createMemoryTransport();
    const service = await Service.create(GreeterContract, handlers, transport.host, {
      env: 'production',
    });

    expect(service.env).toBe('production');
    const client = Client.create(GreeterContract, transport.client);
    expect(await client.greet({ name: 'Bob' })).toEqual({ message: 'Hello, Bob!' });

    await service.stop();
  });

  test('typed contract errors cross the wrapper unchanged', async () => {
    const transport = createMemoryTransport();
    const service = await Service.create(GreeterContract, handlers, transport.host);

    const client = Client.create(GreeterContract, transport.client);
    try {
      await client.fail({ id: 'x-1' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ContractError);
      expect((err as ContractError)._tag).toBe('NotFound');
    }

    await service.stop();
  });
});
