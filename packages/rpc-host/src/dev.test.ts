import { describe, expect, test } from 'bun:test';

import { Contract } from '@insler/rpc-contract';
import { z } from 'zod';

import { loggingMiddleware, validateHandlers } from './dev.js';
import { Host } from './host.js';
import type { HostRegistration, HostTransport, HostUnregister } from './transport.js';

// -- Test helpers --

class MockTransport implements HostTransport {
  registrations: HostRegistration[] = [];

  async register(registration: HostRegistration): Promise<HostUnregister> {
    this.registrations.push(registration);
    return async () => {};
  }

  findHandler(methodName: string) {
    for (const reg of this.registrations) {
      for (const m of reg.methods) {
        if (m.method === methodName && m.kind === 'unary') {
          return m.handler;
        }
      }
    }
    return undefined;
  }
}

// -- Test contracts --

const SimpleContract = Contract.create('test-service', {
  version: '1.0.0',
  methods: {
    greet: {
      input: z.object({ name: z.string() }),
      output: z.object({ message: z.string() }),
    },
    ping: {
      output: z.object({ ok: z.boolean() }),
    },
  },
});

// -- Tests --

describe('loggingMiddleware', () => {
  test('logs request and response with timing', async () => {
    const logs: string[] = [];
    const transport = new MockTransport();

    await Host.create(
      SimpleContract,
      {
        greet: async (input: { name: string }) => ({ message: `Hello, ${input.name}!` }),
        ping: async () => ({ ok: true }),
      } as any,
      transport,
      { middleware: [loggingMiddleware({ logger: (msg) => logs.push(msg) })] }
    );

    const handler = transport.findHandler('greet');
    await handler!({
      service: 'test-service',
      method: 'greet',
      kind: 'unary',
      input: { name: 'Alice' },
    });

    expect(logs).toHaveLength(2);
    expect(logs[0]).toBe('[rpc-host] <- test-service.greet');
    expect(logs[1]).toMatch(/^\[rpc-host\] -> test-service\.greet \(\d+ms\) \(ok\)$/);
  });

  test('logs error responses with tag', async () => {
    const logs: string[] = [];
    const transport = new MockTransport();

    const ErrorContract = Contract.create('err-service', {
      version: '1.0.0',
      methods: {
        fail: {
          input: z.object({ x: z.string() }),
          output: z.object({ y: z.string() }),
          errors: {
            Boom: z.object({ reason: z.string() }),
          },
        },
      },
    });

    await Host.create(
      ErrorContract,
      {
        fail: async () => {
          throw { _tag: 'Boom', payload: { reason: 'kaboom' } };
        },
      } as any,
      transport,
      { middleware: [loggingMiddleware({ logger: (msg) => logs.push(msg) })] }
    );

    const handler = transport.findHandler('fail');
    await handler!({
      service: 'err-service',
      method: 'fail',
      kind: 'unary',
      input: { x: 'test' },
    });

    expect(logs).toHaveLength(2);
    expect(logs[0]).toBe('[rpc-host] <- err-service.fail');
    expect(logs[1]).toMatch(/^\[rpc-host\] -> err-service\.fail \(\d+ms\) \(error: Boom\)$/);
  });

  test('with custom prefix', async () => {
    const logs: string[] = [];
    const transport = new MockTransport();

    await Host.create(
      SimpleContract,
      {
        greet: async (input: { name: string }) => ({ message: `Hello, ${input.name}!` }),
        ping: async () => ({ ok: true }),
      } as any,
      transport,
      {
        middleware: [loggingMiddleware({ logger: (msg) => logs.push(msg), prefix: '[my-app]' })],
      }
    );

    const handler = transport.findHandler('greet');
    await handler!({
      service: 'test-service',
      method: 'greet',
      kind: 'unary',
      input: { name: 'Bob' },
    });

    expect(logs[0]).toBe('[my-app] <- test-service.greet');
    expect(logs[1]).toMatch(/^\[my-app\] -> test-service\.greet/);
  });
});

describe('validateHandlers', () => {
  test('returns empty array for complete handlers', () => {
    const handlers = {
      greet: async () => ({ message: 'hi' }),
      ping: async () => ({ ok: true }),
    };

    const missing = validateHandlers(SimpleContract, handlers);
    expect(missing).toEqual([]);
  });

  test('returns missing method names', () => {
    const handlers = {
      greet: async () => ({ message: 'hi' }),
      // ping is missing
    };

    const missing = validateHandlers(SimpleContract, handlers);
    expect(missing).toEqual(['ping']);
  });

  test('returns all methods when handlers is empty', () => {
    const missing = validateHandlers(SimpleContract, {});
    expect(missing).toHaveLength(2);
    expect(missing).toContain('greet');
    expect(missing).toContain('ping');
  });

  test('non-function properties are treated as missing', () => {
    const handlers = {
      greet: async () => ({ message: 'hi' }),
      ping: 'not a function',
    };

    const missing = validateHandlers(SimpleContract, handlers as any);
    expect(missing).toEqual(['ping']);
  });
});
