import { describe, expect, test } from 'bun:test';

import { ContractError } from '@insler/rpc/client';
import { Contract } from '@insler/rpc/contract';
import { z } from 'zod';

import { ServiceTest } from './test.js';

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

describe('ServiceTest.pair()', () => {
  test('creates a working test pair', async () => {
    const { client, host, stop } = await ServiceTest.pair(SimpleContract, {
      greet: async (input) => ({ message: `Hello, ${input.name}!` }),
      add: async (input) => ({ sum: input.a + input.b }),
    });

    expect(client).toBeDefined();
    expect(host).toBeDefined();

    const result = await client.greet({ name: 'Alice' });
    expect(result).toEqual({ message: 'Hello, Alice!' });

    const addResult = await client.add({ a: 5, b: 7 });
    expect(addResult).toEqual({ sum: 12 });

    await stop();
  });

  test('propagates errors', async () => {
    const { client, stop } = await ServiceTest.pair(ContractWithErrors, {
      getItem: async (input) => {
        if (input.id === 'missing') {
          throw { _tag: 'NotFound', payload: { id: input.id } };
        }
        return { id: input.id, name: 'Test Item' };
      },
    });

    const item = await client.getItem({ id: 'abc' });
    expect(item).toEqual({ id: 'abc', name: 'Test Item' });

    try {
      await client.getItem({ id: 'missing' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ContractError);
      expect((err as ContractError)._tag).toBe('NotFound');
    }

    await stop();
  });

  test('propagates context', async () => {
    const { client, stop } = await ServiceTest.pair(ContractWithContext, {
      whoami: async (ctx) => ({ userId: ctx.identity.userId }),
    });

    const result = await client.whoami({ identity: { userId: 'user-42' } });
    expect(result).toEqual({ userId: 'user-42' });

    await stop();
  });

  test('validates handlers at creation time', async () => {
    await expect(
      ServiceTest.pair(SimpleContract, { greet: async () => ({ message: 'hi' }) } as any)
    ).rejects.toThrow(/Missing handlers.*add/);
  });

  test('stop() cleans up resources', async () => {
    const { stop } = await ServiceTest.pair(SimpleContract, {
      greet: async (input) => ({ message: `Hello, ${input.name}!` }),
      add: async (input) => ({ sum: input.a + input.b }),
    });

    await stop();
  });
});

describe('ServiceTest.resultPair()', () => {
  test('returns result-mode client', async () => {
    const { client, stop } = await ServiceTest.resultPair(ContractWithErrors, {
      getItem: async (input) => {
        if (input.id === 'missing') {
          throw { _tag: 'NotFound', payload: { id: input.id } };
        }
        return { id: input.id, name: 'Test Item' };
      },
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

  test('validates handlers at creation time', async () => {
    await expect(ServiceTest.resultPair(ContractWithErrors, {} as any)).rejects.toThrow(
      /Missing handlers.*getItem/
    );
  });
});
