import { describe, expect, test } from 'bun:test';

import { Contract } from '@insler/rpc-contract';
import { z } from 'zod';

import { Host } from './host.js';
import type { HostMiddleware, HostStreamMiddleware } from './middleware.js';
import type { HostRegistration, HostRequest, HostTransport, HostUnregister } from './transport.js';

// -- Test helpers --

class MockTransport implements HostTransport {
  registrations: HostRegistration[] = [];
  unregisterCalled = false;

  async register(registration: HostRegistration): Promise<HostUnregister> {
    this.registrations.push(registration);
    return async () => {
      this.unregisterCalled = true;
    };
  }

  findMethod(methodName: string) {
    for (const reg of this.registrations) {
      for (const m of reg.methods) {
        if (m.method === methodName) {
          return m;
        }
      }
    }
    return undefined;
  }

  findHandler(methodName: string) {
    const m = this.findMethod(methodName);
    return m?.kind === 'unary' ? m.handler : undefined;
  }
}

const IdentitySchema = z.object({
  userId: z.string(),
  principalId: z.string(),
  orgId: z.string().optional(),
});

// -- Test contracts --

const SimpleContract = Contract.create('simple-service', {
  version: '1.0.0',
  methods: {
    greet: {
      input: z.object({ name: z.string() }),
      output: z.object({ message: z.string() }),
    },
  },
});

const ContractWithContext = Contract.create('context-service', {
  version: '1.0.0',
  context: { identity: IdentitySchema },
  methods: {
    getProfile: {
      input: z.object({ userId: z.string() }),
      output: z.object({
        userId: z.string(),
        name: z.string(),
        requestedBy: z.string(),
      }),
    },
  },
});

const ContractWithErrors = Contract.create('error-service', {
  version: '1.0.0',
  methods: {
    getModel: {
      input: z.object({ modelId: z.string() }),
      output: z.object({ id: z.string(), name: z.string() }),
      errors: {
        NotFound: z.object({ modelId: z.string() }),
        Forbidden: z.object({ reason: z.string() }),
      },
    },
  },
});

const ContractWithVoidInput = Contract.create('void-input-service', {
  version: '1.0.0',
  methods: {
    healthCheck: {
      output: z.object({ ok: z.boolean() }),
    },
  },
});

const ContractWithEmptyContext = Contract.create('empty-context-service', {
  version: '1.0.0',
  context: { identity: IdentitySchema },
  methods: {
    healthCheck: {
      context: {},
      output: z.object({ ok: z.boolean() }),
    },
  },
});

const ContractWithStream = Contract.create('stream-service', {
  version: '1.0.0',
  methods: {
    watch: {
      kind: 'serverStream',
      output: z.object({ event: z.string() }),
    },
  },
});

const ContractWithContextStream = Contract.create('stream-ctx-service', {
  version: '1.0.0',
  context: { identity: IdentitySchema },
  methods: {
    watch: {
      kind: 'serverStream',
      output: z.object({ who: z.string() }),
    },
  },
});

// -- Tests --

describe('Host.create()', () => {
  test('basic unary handler: valid input produces correct output', async () => {
    const transport = new MockTransport();
    await Host.create(
      SimpleContract,
      {
        greet: async (input: { name: string }) => ({
          message: `Hello, ${input.name}!`,
        }),
      } as any,
      transport
    );

    const handler = transport.findHandler('greet');
    expect(handler).toBeDefined();

    const response = await handler!({
      service: 'simple-service',
      method: 'greet',
      kind: 'unary',
      input: { name: 'Alice' },
    });

    expect(response.error).toBeUndefined();
    expect(response.output).toEqual({ message: 'Hello, Alice!' });
  });

  test('context extraction: parses JSON metadata into typed context', async () => {
    const transport = new MockTransport();
    await Host.create(
      ContractWithContext,
      {
        getProfile: async (
          context: { identity: { userId: string; principalId: string } },
          input: { userId: string }
        ) => ({
          userId: input.userId,
          name: 'Alice',
          requestedBy: context.identity.userId,
        }),
      } as any,
      transport
    );

    const handler = transport.findHandler('getProfile');
    expect(handler).toBeDefined();

    const response = await handler!({
      service: 'context-service',
      method: 'getProfile',
      kind: 'unary',
      input: { userId: 'user-1' },
      metadata: {
        identity: JSON.stringify({
          userId: 'admin-1',
          principalId: 'p-1',
        }),
      },
    });

    expect(response.error).toBeUndefined();
    expect(response.output).toEqual({
      userId: 'user-1',
      name: 'Alice',
      requestedBy: 'admin-1',
    });
  });

  test('input validation: rejects invalid input with error response', async () => {
    const transport = new MockTransport();
    await Host.create(
      SimpleContract,
      {
        greet: async (input: { name: string }) => ({
          message: `Hello, ${input.name}!`,
        }),
      } as any,
      transport
    );

    const handler = transport.findHandler('greet');
    const response = await handler!({
      service: 'simple-service',
      method: 'greet',
      kind: 'unary',
      input: { name: 42 }, // wrong type
    });

    expect(response.error).toBeDefined();
    expect(response.error!._tag).toBe('__validation__');
    expect(response.output).toBeUndefined();
  });

  test('output validation: rejects invalid handler return with error response', async () => {
    const transport = new MockTransport();
    await Host.create(
      SimpleContract,
      {
        greet: async () => ({
          wrong_field: 'oops',
        }),
      } as any,
      transport
    );

    const handler = transport.findHandler('greet');
    const response = await handler!({
      service: 'simple-service',
      method: 'greet',
      kind: 'unary',
      input: { name: 'Alice' },
    });

    expect(response.error).toBeDefined();
    expect(response.error!._tag).toBe('__validation__');
    expect(response.output).toBeUndefined();
  });

  test('exception safety: contract errors propagate with _tag and payload', async () => {
    const transport = new MockTransport();
    await Host.create(
      ContractWithErrors,
      {
        getModel: async () => {
          throw { _tag: 'NotFound', payload: { modelId: '123' } };
        },
      } as any,
      transport
    );

    const handler = transport.findHandler('getModel');
    const response = await handler!({
      service: 'error-service',
      method: 'getModel',
      kind: 'unary',
      input: { modelId: '123' },
    });

    expect(response.error).toBeDefined();
    expect(response.error!._tag).toBe('NotFound');
    expect(response.error!.payload).toEqual({ modelId: '123' });
    expect(response.output).toBeUndefined();
  });

  test('exception safety: unknown errors return generic response', async () => {
    const transport = new MockTransport();
    await Host.create(
      SimpleContract,
      {
        greet: async () => {
          throw new Error('database down');
        },
      } as any,
      transport
    );

    const handler = transport.findHandler('greet');
    const response = await handler!({
      service: 'simple-service',
      method: 'greet',
      kind: 'unary',
      input: { name: 'Alice' },
    });

    expect(response.error).toBeDefined();
    expect(response.error!._tag).toBe('__unknown__');
    expect(response.error!.message).toBe('database down');
    expect(response.error!.payload).toBeUndefined();
    expect(response.output).toBeUndefined();
  });

  test('exception safety: non-Error throws return generic message', async () => {
    const transport = new MockTransport();
    await Host.create(
      SimpleContract,
      {
        greet: async () => {
          throw 'string error';
        },
      } as any,
      transport
    );

    const handler = transport.findHandler('greet');
    const response = await handler!({
      service: 'simple-service',
      method: 'greet',
      kind: 'unary',
      input: { name: 'Alice' },
    });

    expect(response.error).toBeDefined();
    expect(response.error!._tag).toBe('__unknown__');
    expect(response.error!.message).toBe('Unknown error');
  });

  test('middleware: single middleware can modify metadata', async () => {
    const transport = new MockTransport();
    const addHeaderMiddleware: HostMiddleware = async (request, next) => {
      return next({
        ...request,
        metadata: {
          ...request.metadata,
          added: 'by-middleware',
        },
      });
    };

    await Host.create(
      SimpleContract,
      {
        greet: async (input: { name: string }) => ({
          message: `Hello, ${input.name}!`,
        }),
      } as any,
      transport,
      { middleware: [addHeaderMiddleware] }
    );

    const handler = transport.findHandler('greet');
    const response = await handler!({
      service: 'simple-service',
      method: 'greet',
      kind: 'unary',
      input: { name: 'Alice' },
      metadata: { existing: 'value' },
    });

    expect(response.error).toBeUndefined();
    expect(response.output).toEqual({ message: 'Hello, Alice!' });
  });

  test('middleware ordering: executes in array order', async () => {
    const transport = new MockTransport();
    const order: string[] = [];

    const first: HostMiddleware = async (request, next) => {
      order.push('first-before');
      const response = await next(request);
      order.push('first-after');
      return response;
    };

    const second: HostMiddleware = async (request, next) => {
      order.push('second-before');
      const response = await next(request);
      order.push('second-after');
      return response;
    };

    await Host.create(
      SimpleContract,
      {
        greet: async (input: { name: string }) => {
          order.push('handler');
          return { message: `Hello, ${input.name}!` };
        },
      } as any,
      transport,
      { middleware: [first, second] }
    );

    const handler = transport.findHandler('greet');
    await handler!({
      service: 'simple-service',
      method: 'greet',
      kind: 'unary',
      input: { name: 'Alice' },
    });

    expect(order).toEqual([
      'first-before',
      'second-before',
      'handler',
      'second-after',
      'first-after',
    ]);
  });

  test('methods with empty context override: handler called without context', async () => {
    const transport = new MockTransport();
    let receivedArgs: unknown[] = [];

    await Host.create(
      ContractWithEmptyContext,
      {
        healthCheck: async (...args: unknown[]) => {
          receivedArgs = args;
          return { ok: true };
        },
      } as any,
      transport
    );

    const handler = transport.findHandler('healthCheck');
    const response = await handler!({
      service: 'empty-context-service',
      method: 'healthCheck',
      kind: 'unary',
      metadata: {
        identity: JSON.stringify({
          userId: 'u1',
          principalId: 'p1',
        }),
      },
    });

    expect(response.error).toBeUndefined();
    expect(response.output).toEqual({ ok: true });
    // No context and no input args should be passed
    expect(receivedArgs).toHaveLength(0);
  });

  test('methods with void input: handler called without input', async () => {
    const transport = new MockTransport();
    let receivedArgs: unknown[] = [];

    await Host.create(
      ContractWithVoidInput,
      {
        healthCheck: async (...args: unknown[]) => {
          receivedArgs = args;
          return { ok: true };
        },
      } as any,
      transport
    );

    const handler = transport.findHandler('healthCheck');
    const response = await handler!({
      service: 'void-input-service',
      method: 'healthCheck',
      kind: 'unary',
    });

    expect(response.error).toBeUndefined();
    expect(response.output).toEqual({ ok: true });
    expect(receivedArgs).toHaveLength(0);
  });

  test('stop() calls transport unregister', async () => {
    const transport = new MockTransport();
    const host = await Host.create(
      SimpleContract,
      {
        greet: async (input: { name: string }) => ({
          message: `Hello, ${input.name}!`,
        }),
      } as any,
      transport
    );

    expect(transport.unregisterCalled).toBe(false);
    await host.stop();
    expect(transport.unregisterCalled).toBe(true);
  });

  test('registers correct service name from contract kind', async () => {
    const transport = new MockTransport();
    await Host.create(
      SimpleContract,
      {
        greet: async (input: { name: string }) => ({
          message: `Hello, ${input.name}!`,
        }),
      } as any,
      transport
    );

    expect(transport.registrations).toHaveLength(1);
    expect(transport.registrations[0]!.service).toBe('simple-service');
  });

  test('registers all methods from contract', async () => {
    const MultiMethodContract = Contract.create('multi-service', {
      version: '1.0.0',
      methods: {
        alpha: {
          input: z.object({ x: z.number() }),
          output: z.object({ result: z.number() }),
        },
        beta: {
          input: z.object({ y: z.string() }),
          output: z.object({ result: z.string() }),
        },
      },
    });

    const transport = new MockTransport();
    await Host.create(
      MultiMethodContract,
      {
        alpha: async (input: { x: number }) => ({ result: input.x * 2 }),
        beta: async (input: { y: string }) => ({
          result: input.y.toUpperCase(),
        }),
      } as any,
      transport
    );

    expect(transport.registrations[0]!.methods).toHaveLength(2);
    const methodNames = transport.registrations[0]!.methods.map((m) => m.method);
    expect(methodNames).toContain('alpha');
    expect(methodNames).toContain('beta');
  });

  test('throws when handler is missing for a method', async () => {
    const transport = new MockTransport();

    await expect(Host.create(SimpleContract, {} as any, transport)).rejects.toThrow(
      "Missing handler for method 'greet' in contract 'simple-service'"
    );
  });

  test('server stream handler is registered with correct kind', async () => {
    const transport = new MockTransport();
    await Host.create(
      ContractWithStream,
      {
        async *watch() {
          yield { event: 'started' };
          yield { event: 'stopped' };
        },
      } as any,
      transport
    );

    const method = transport.findMethod('watch');
    expect(method).toBeDefined();
    expect(method!.kind).toBe('serverStream');
  });

  test('server stream handler yields validated outputs', async () => {
    const transport = new MockTransport();
    await Host.create(
      ContractWithStream,
      {
        async *watch() {
          yield { event: 'one' };
          yield { event: 'two' };
        },
      } as any,
      transport
    );

    const method = transport.findMethod('watch');
    expect(method!.kind).toBe('serverStream');

    const handler = (method as any).handler;
    const results: unknown[] = [];
    for await (const r of handler({
      service: 'stream-service',
      method: 'watch',
      kind: 'serverStream',
    })) {
      results.push(r);
    }

    expect(results).toEqual([{ output: { event: 'one' } }, { output: { event: 'two' } }]);
  });

  test('server stream handler validates each output item', async () => {
    const transport = new MockTransport();
    await Host.create(
      ContractWithStream,
      {
        async *watch() {
          yield { event: 'valid' };
          yield { wrong: 'field' };
        },
      } as any,
      transport
    );

    const method = transport.findMethod('watch');
    const handler = (method as any).handler;
    const results: unknown[] = [];
    for await (const r of handler({
      service: 'stream-service',
      method: 'watch',
      kind: 'serverStream',
    })) {
      results.push(r);
    }

    expect(results).toHaveLength(2);
    expect((results[0] as any).output).toEqual({ event: 'valid' });
    expect((results[1] as any).error._tag).toBe('__validation__');
  });

  test('contract error with message propagates the message', async () => {
    const transport = new MockTransport();
    await Host.create(
      ContractWithErrors,
      {
        getModel: async () => {
          throw {
            _tag: 'Forbidden',
            payload: { reason: 'no access' },
            message: 'Access denied',
          };
        },
      } as any,
      transport
    );

    const handler = transport.findHandler('getModel');
    const response = await handler!({
      service: 'error-service',
      method: 'getModel',
      kind: 'unary',
      input: { modelId: '456' },
    });

    expect(response.error).toBeDefined();
    expect(response.error!._tag).toBe('Forbidden');
    expect(response.error!.payload).toEqual({ reason: 'no access' });
    expect(response.error!.message).toBe('Access denied');
  });

  test('middleware can short-circuit and return early', async () => {
    const transport = new MockTransport();
    let handlerCalled = false;

    const shortCircuit: HostMiddleware = async () => {
      return { error: { _tag: 'ShortCircuit', message: 'blocked' } };
    };

    await Host.create(
      SimpleContract,
      {
        greet: async () => {
          handlerCalled = true;
          return { message: 'should not reach' };
        },
      } as any,
      transport,
      { middleware: [shortCircuit] }
    );

    const handler = transport.findHandler('greet');
    const response = await handler!({
      service: 'simple-service',
      method: 'greet',
      kind: 'unary',
      input: { name: 'Alice' },
    });

    expect(handlerCalled).toBe(false);
    expect(response.error).toBeDefined();
    expect(response.error!._tag).toBe('ShortCircuit');
  });
});

// -- serverStream middleware (issue 0001) --

describe('serverStream middleware', () => {
  test('host middleware wraps the registered serverStream handler; mutated metadata is visible to the handler', async () => {
    const transport = new MockTransport();

    // Inject identity into request metadata; the handler should see it via context extraction,
    // proving the middleware ran around (and before) the validated handler.
    const inject: HostStreamMiddleware = (request, next) =>
      next({
        ...request,
        metadata: {
          ...request.metadata,
          identity: JSON.stringify({ userId: 'mw-user', principalId: 'p1' }),
        },
      });

    await Host.create(
      ContractWithContextStream,
      {
        async *watch(ctx: { identity: { userId: string } }) {
          yield { who: ctx.identity.userId };
        },
      } as any,
      transport,
      { middleware: [inject] }
    );

    const method = transport.findMethod('watch');
    expect(method!.kind).toBe('serverStream');

    const handler = (method as any).handler;
    const results: unknown[] = [];
    for await (const r of handler({
      service: 'stream-ctx-service',
      method: 'watch',
      kind: 'serverStream',
    })) {
      results.push(r);
    }

    expect(results).toEqual([{ output: { who: 'mw-user' } }]);
  });

  test('middleware order for serverStream is "first in the array is outermost"', async () => {
    const transport = new MockTransport();
    const order: string[] = [];

    const first: HostStreamMiddleware = (request, next) => {
      order.push('first-before');
      const stream = next(request as HostRequest & { kind: 'serverStream' });
      return (async function* () {
        yield* stream;
        order.push('first-after');
      })();
    };
    const second: HostStreamMiddleware = (request, next) => {
      order.push('second-before');
      const stream = next(request as HostRequest & { kind: 'serverStream' });
      return (async function* () {
        yield* stream;
        order.push('second-after');
      })();
    };

    await Host.create(
      ContractWithStream,
      {
        async *watch() {
          order.push('handler');
          yield { event: 'x' };
        },
      } as any,
      transport,
      { middleware: [first, second] }
    );

    const method = transport.findMethod('watch');
    const handler = (method as any).handler;
    for await (const _ of handler({
      service: 'stream-service',
      method: 'watch',
      kind: 'serverStream',
    })) {
      // drain
    }

    expect(order).toEqual([
      'first-before',
      'second-before',
      'handler',
      'second-after',
      'first-after',
    ]);
  });

  test('serverStream handler still validates outputs when wrapped with middleware', async () => {
    const transport = new MockTransport();
    const passthrough: HostStreamMiddleware = (request, next) => next(request);

    await Host.create(
      ContractWithStream,
      {
        async *watch() {
          yield { event: 'valid' };
          yield { wrong: 'field' };
        },
      } as any,
      transport,
      { middleware: [passthrough] }
    );

    const method = transport.findMethod('watch');
    const handler = (method as any).handler;
    const results: unknown[] = [];
    for await (const r of handler({
      service: 'stream-service',
      method: 'watch',
      kind: 'serverStream',
    })) {
      results.push(r);
    }

    expect(results).toHaveLength(2);
    expect((results[0] as any).output).toEqual({ event: 'valid' });
    expect((results[1] as any).error._tag).toBe('__validation__');
  });
});
