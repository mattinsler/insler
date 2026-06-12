import { describe, expect, test } from 'bun:test';

import { z } from 'zod';

import { ContractError as ClientContractError } from './client/index.js';
import { Client, Contract, ContractError, createMemoryTransport, Host } from './index.js';

// The 0-to-value story of the @insler/rpc umbrella (subsystem-layout issue
// 0003): the root entrypoint alone — contract + client + host + memory
// transport — yields a working in-process service, and type identity holds
// across entrypoints (one copy of the typed-error class, so `instanceof`
// works no matter which entrypoint produced the value).

describe('@insler/rpc root entrypoint — 0-to-value', () => {
  const Calculator = Contract.create('calculator', {
    version: '1.0.0',
    methods: {
      add: {
        input: z.object({ a: z.number(), b: z.number() }),
        output: z.object({ result: z.number() }),
      },
      divide: {
        input: z.object({ a: z.number(), b: z.number() }),
        output: z.object({ result: z.number() }),
        errors: {
          DivisionByZero: z.object({ message: z.string() }),
        },
      },
    },
  });

  const handlers = {
    add: async (input: { a: number; b: number }) => ({ result: input.a + input.b }),
    divide: async (input: { a: number; b: number }) => {
      if (input.b === 0) {
        throw { _tag: 'DivisionByZero', payload: { message: 'Cannot divide by zero' } };
      }
      return { result: input.a / input.b };
    },
  };

  test('a working in-process service from the root entrypoint alone', async () => {
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();
    const host = await Host.create(Calculator, handlers as never, hostTransport);
    const client = Client.create(Calculator, clientTransport);

    expect(await client.add({ a: 3, b: 4 })).toEqual({ result: 7 });

    await host.stop();
  });

  test('typed errors thrown through the stack are instanceof ContractError', async () => {
    const { client: clientTransport, host: hostTransport } = createMemoryTransport();
    const host = await Host.create(Calculator, handlers as never, hostTransport);
    const client = Client.create(Calculator, clientTransport);

    try {
      await client.divide({ a: 1, b: 0 });
      expect.unreachable('divide by zero must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError);
    }

    await host.stop();
  });

  test('type identity: one copy of the typed-error class across entrypoints', () => {
    expect(Object.is(ContractError, ClientContractError)).toBe(true);
  });
});
