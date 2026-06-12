import { describe, expect, test } from 'bun:test';

import { ContractError } from '@insler/rpc/client';
import { Contract } from '@insler/rpc/contract';
import type { ContractDef } from '@insler/rpc/contract';
import { Host } from '@insler/rpc/host';
import { createMemoryTransport } from '@insler/rpc/transport-memory';
import { z } from 'zod';

import { ServiceClient } from './client.js';

const SimpleContract = Contract.create('simple-service', {
  version: '1.0.0',
  methods: {
    greet: {
      input: z.object({ name: z.string() }),
      output: z.object({ message: z.string() }),
    },
  },
});

const ContractWithErrors = Contract.create('error-service', {
  version: '1.0.0',
  methods: {
    getItem: {
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), name: z.string() }),
      errors: {
        NotFound: z.object({ id: z.string() }),
      },
    },
  },
});

const IdentitySchema = z.object({ userId: z.string() });

const ContractWithContext = Contract.create('context-service', {
  version: '1.0.0',
  context: { identity: IdentitySchema },
  methods: {
    whoami: {
      output: z.object({ userId: z.string() }),
    },
  },
});

const simpleHandlers: Contract.Handlers<typeof SimpleContract> = {
  greet: async (input) => ({ message: `Hello, ${input.name}!` }),
};

const errorHandlers: Contract.Handlers<typeof ContractWithErrors> = {
  getItem: async (input) => {
    if (input.id === 'missing') {
      throw { _tag: 'NotFound', payload: { id: input.id } };
    }
    return { id: input.id, name: 'Test Item' };
  },
};

const contextHandlers: Contract.Handlers<typeof ContractWithContext> = {
  whoami: async (ctx) => ({ userId: ctx.identity.userId }),
};

async function setupHost<C extends ContractDef>(contract: C, handlers: Contract.Handlers<C>) {
  const transport = createMemoryTransport();
  const host = await Host.create(contract, handlers, transport.host);
  return { transport, host, stop: () => host.stop() };
}

describe('ServiceClient.create()', () => {
  test('creates a throw-mode client', async () => {
    const { transport, stop } = await setupHost(SimpleContract, simpleHandlers);

    const client = ServiceClient.create(SimpleContract, transport.client, {
      env: 'production',
    });

    const result = await client.greet({ name: 'Alice' });
    expect(result).toEqual({ message: 'Hello, Alice!' });

    await stop();
  });

  test('creates a result-mode client', async () => {
    const { transport, stop } = await setupHost(ContractWithErrors, errorHandlers);

    const client = ServiceClient.create(ContractWithErrors, transport.client, {
      errors: 'result',
      env: 'production',
    });

    const okResult = await client.getItem({ id: 'abc' });
    expect(okResult).toEqual({ ok: true, value: { id: 'abc', name: 'Test Item' } });

    const errResult = await client.getItem({ id: 'missing' });
    expect(errResult).toEqual({
      ok: false,
      error: { _tag: 'NotFound', payload: { id: 'missing' } },
    });

    await stop();
  });

  test('throw-mode throws ContractError', async () => {
    const { transport, stop } = await setupHost(ContractWithErrors, errorHandlers);

    const client = ServiceClient.create(ContractWithErrors, transport.client, {
      env: 'production',
    });

    try {
      await client.getItem({ id: 'missing' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ContractError);
      expect((err as ContractError)._tag).toBe('NotFound');
    }

    await stop();
  });

  test('works with development env', async () => {
    const { transport, stop } = await setupHost(SimpleContract, simpleHandlers);

    const client = ServiceClient.create(SimpleContract, transport.client, {
      env: 'development',
    });

    const result = await client.greet({ name: 'Bob' });
    expect(result).toEqual({ message: 'Hello, Bob!' });

    await stop();
  });

  test('accepts custom middleware', async () => {
    const calls: string[] = [];

    const { transport, stop } = await setupHost(SimpleContract, simpleHandlers);

    const client = ServiceClient.create(SimpleContract, transport.client, {
      env: 'production',
      middleware: [
        async (request, next) => {
          calls.push(`before:${request.method}`);
          const response = await next(request);
          calls.push(`after:${request.method}`);
          return response;
        },
      ],
    });

    await client.greet({ name: 'Alice' });
    expect(calls).toEqual(['before:greet', 'after:greet']);

    await stop();
  });
});

describe('ServiceClient.withContext()', () => {
  test('creates a scoped client with pre-applied context', async () => {
    const { transport, stop } = await setupHost(ContractWithContext, contextHandlers);

    const client = ServiceClient.create(ContractWithContext, transport.client, {
      env: 'production',
    });
    const scoped = ServiceClient.withContext(client, {
      identity: { userId: 'user-42' },
    });

    const result = await scoped.whoami();
    expect(result).toEqual({ userId: 'user-42' });

    await stop();
  });
});
