import { describe, expect, test } from 'bun:test';

import { ContractError } from '@insler/rpc/client';
import { Client } from '@insler/rpc/client';
import { Contract } from '@insler/rpc/contract';
import { createMemoryTransport } from '@insler/rpc/transport-memory';
import { z } from 'zod';

import { Service } from './index.js';

const SimpleContract = Contract.create('simple-service', {
  version: '1.0.0',
  methods: {
    greet: {
      input: z.object({ name: z.string() }),
      output: z.object({ message: z.string() }),
    },
    add: {
      input: z.object({ a: z.number(), b: z.number() }),
      output: z.object({ sum: z.number() }),
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
  add: async (input) => ({ sum: input.a + input.b }),
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

describe('Service.create()', () => {
  test('creates a working host with production env', async () => {
    const transport = createMemoryTransport();
    const host = await Service.create(SimpleContract, simpleHandlers, transport.host, {
      env: 'production',
    });

    expect(host).toBeDefined();
    expect(host.env).toBe('production');

    const client = Client.create(SimpleContract, transport.client);
    const result = await client.greet({ name: 'Alice' });
    expect(result).toEqual({ message: 'Hello, Alice!' });

    await host.stop();
  });

  test('creates a working host with development env', async () => {
    const transport = createMemoryTransport();
    const host = await Service.create(SimpleContract, simpleHandlers, transport.host, {
      env: 'development',
    });

    expect(host.env).toBe('development');

    const client = Client.create(SimpleContract, transport.client);
    const result = await client.add({ a: 2, b: 3 });
    expect(result).toEqual({ sum: 5 });

    await host.stop();
  });

  test('creates a working host with test env', async () => {
    const transport = createMemoryTransport();
    const host = await Service.create(SimpleContract, simpleHandlers, transport.host, {
      env: 'test',
    });

    expect(host.env).toBe('test');
    await host.stop();
  });

  test('propagates contract errors', async () => {
    const transport = createMemoryTransport();
    const host = await Service.create(ContractWithErrors, errorHandlers, transport.host, {
      env: 'production',
    });

    const client = Client.create(ContractWithErrors, transport.client);

    const item = await client.getItem({ id: 'abc' });
    expect(item).toEqual({ id: 'abc', name: 'Test Item' });

    try {
      await client.getItem({ id: 'missing' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ContractError);
      expect((err as ContractError)._tag).toBe('NotFound');
    }

    await host.stop();
  });

  test('propagates context through host', async () => {
    const transport = createMemoryTransport();
    const host = await Service.create(ContractWithContext, contextHandlers, transport.host, {
      env: 'production',
    });

    const client = Client.create(ContractWithContext, transport.client);
    const result = await client.whoami({ identity: { userId: 'user-42' } });
    expect(result).toEqual({ userId: 'user-42' });

    await host.stop();
  });

  test('validates handlers in dev env', async () => {
    const transport = createMemoryTransport();
    const incompleteHandlers = { greet: simpleHandlers.greet } as any;

    await expect(
      Service.create(SimpleContract, incompleteHandlers, transport.host, { env: 'development' })
    ).rejects.toThrow(/Missing handlers.*add/);
  });

  test('validates handlers in test env', async () => {
    const transport = createMemoryTransport();
    const incompleteHandlers = { greet: simpleHandlers.greet } as any;

    await expect(
      Service.create(SimpleContract, incompleteHandlers, transport.host, { env: 'test' })
    ).rejects.toThrow(/Missing handlers.*add/);
  });

  test('skips handler validation in production', async () => {
    const transport = createMemoryTransport();
    const incompleteHandlers = { greet: simpleHandlers.greet } as any;

    // Production skips validation - Host.create will still throw, but from the underlying host
    // not from our validation layer
    await expect(
      Service.create(SimpleContract, incompleteHandlers, transport.host, { env: 'production' })
    ).rejects.toThrow(/Missing handler/);
  });

  test('accepts custom middleware', async () => {
    const calls: string[] = [];

    const transport = createMemoryTransport();
    const host = await Service.create(SimpleContract, simpleHandlers, transport.host, {
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

    const client = Client.create(SimpleContract, transport.client);
    await client.greet({ name: 'Alice' });

    expect(calls).toEqual(['before:greet', 'after:greet']);

    await host.stop();
  });

  test('stop() cleans up resources', async () => {
    const transport = createMemoryTransport();
    const host = await Service.create(SimpleContract, simpleHandlers, transport.host, {
      env: 'production',
    });

    await host.stop();
    // Calling stop twice should be safe
    await host.stop();
  });
});
