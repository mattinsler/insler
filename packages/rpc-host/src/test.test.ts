import { describe, expect, test } from 'bun:test';

import { ContractError } from '@insler/rpc-client';
import { Contract } from '@insler/rpc-contract';
import { z } from 'zod';

import { TestHost } from './test.js';

// -- Test contracts --

const SimpleContract = Contract.create('test-service', {
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

const IdentitySchema = z.object({
  userId: z.string(),
});

const ContractWithContext = Contract.create('context-service', {
  version: '1.0.0',
  context: { identity: IdentitySchema },
  methods: {
    whoami: {
      output: z.object({ userId: z.string() }),
    },
  },
});

// -- Handlers --

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

// -- Tests --

describe('TestHost.pair()', () => {
  test('creates a working client+host pair', async () => {
    const { client, host, stop } = await TestHost.pair(SimpleContract, simpleHandlers);
    expect(client).toBeDefined();
    expect(host).toBeDefined();
    expect(typeof stop).toBe('function');
    await stop();
  });

  test('client can make typed unary calls', async () => {
    const { client, stop } = await TestHost.pair(SimpleContract, simpleHandlers);

    const result = await client.greet({ name: 'Alice' });
    expect(result).toEqual({ message: 'Hello, Alice!' });

    const addResult = await client.add({ a: 2, b: 3 });
    expect(addResult).toEqual({ sum: 5 });

    await stop();
  });

  test('error propagation works through the pair', async () => {
    const { client, stop } = await TestHost.pair(ContractWithErrors, errorHandlers);

    // Successful call
    const item = await client.getItem({ id: 'abc' });
    expect(item).toEqual({ id: 'abc', name: 'Test Item' });

    // Error call
    try {
      await client.getItem({ id: 'missing' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ContractError);
      const contractErr = err as ContractError;
      expect(contractErr._tag).toBe('NotFound');
      expect(contractErr.payload).toEqual({ id: 'missing' });
    }

    await stop();
  });

  test('context propagation works', async () => {
    const { client, stop } = await TestHost.pair(ContractWithContext, contextHandlers);

    const result = await client.whoami({ identity: { userId: 'user-42' } });
    expect(result).toEqual({ userId: 'user-42' });

    await stop();
  });

  test('stop() cleans up resources', async () => {
    const { host, stop } = await TestHost.pair(SimpleContract, simpleHandlers);
    // Calling stop should not throw
    await stop();
    // Calling stop on the host directly should also be safe
    await host.stop();
  });
});

describe('TestHost.resultPair()', () => {
  test('returns result-mode client', async () => {
    const { client, stop } = await TestHost.resultPair(ContractWithErrors, errorHandlers);

    // Successful call returns ok result
    const okResult = await client.getItem({ id: 'abc' });
    expect(okResult).toEqual({ ok: true, value: { id: 'abc', name: 'Test Item' } });

    // Error call returns error result instead of throwing
    const errResult = await client.getItem({ id: 'missing' });
    expect(errResult).toEqual({
      ok: false,
      error: { _tag: 'NotFound', payload: { id: 'missing' } },
    });

    await stop();
  });
});
