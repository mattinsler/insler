import { describe, expect, test } from 'bun:test';

import { z } from 'zod';

import { Contract } from './index.js';

// -- Test contract setup --

const IdentitySchema = z.object({
  userId: z.string(),
  principalId: z.string(),
  orgId: z.string().optional(),
});

const ModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
});

const ModelNotFoundPayload = z.object({ modelId: z.string() });

const TestContract = Contract.create('test-svc', {
  version: '1.0.0',
  context: {
    identity: IdentitySchema,
  },
  methods: {
    getModel: {
      kind: 'unary',
      input: z.object({ modelId: z.string() }),
      output: ModelSchema,
      errors: { NotFound: ModelNotFoundPayload },
    },
    listModels: {
      kind: 'unary',
      input: z.object({ provider: z.string().optional() }),
      output: z.object({ data: z.array(ModelSchema) }),
    },
    watchModels: {
      kind: 'serverStream',
      output: ModelSchema,
    },
    healthCheck: {
      context: {},
      input: z.void(),
      output: z.object({ ok: z.boolean() }),
    },
    noInputUnary: {
      kind: 'unary',
      output: z.object({ count: z.number() }),
    },
  },
});

type TestContractType = typeof TestContract;

// -- Type-level assertion helpers --

/**
 * If the assignment compiles, the types are compatible.
 * We wrap in a function so it's never actually called.
 */
function assertType<T>(_value: T): void {}

// -- Tests --

describe('Contract.Handlers', () => {
  test('type-level: handlers have correct method signatures', () => {
    type H = Contract.Handlers<TestContractType>;

    // getModel: has identity context + input => Promise<output>
    assertType<H['getModel']>(
      async (
        _ctx: { identity: { userId: string; principalId: string; orgId?: string } },
        _input: { modelId: string }
      ) => ({ id: '1', name: 'test', provider: 'openai' })
    );

    // listModels: has identity context + input => Promise<output>
    assertType<H['listModels']>(
      async (
        _ctx: { identity: { userId: string; principalId: string; orgId?: string } },
        _input: { provider?: string }
      ) => ({ data: [] })
    );

    // watchModels: serverStream with identity context, void input => AsyncIterable<output>
    assertType<H['watchModels']>(async function* (_ctx: {
      identity: { userId: string; principalId: string; orgId?: string };
    }) {
      yield { id: '1', name: 'test', provider: 'openai' };
    });

    // healthCheck: empty context + void input => no context param, no input param
    assertType<H['healthCheck']>(async () => ({ ok: true }));

    // noInputUnary: has identity context but void input => only context param
    assertType<H['noInputUnary']>(
      async (_ctx: { identity: { userId: string; principalId: string; orgId?: string } }) => ({
        count: 42,
      })
    );

    expect(true).toBe(true);
  });
});

describe('Contract.Client', () => {
  test('type-level: client methods have correct signatures', () => {
    type C = Contract.Client<TestContractType>;

    // getModel: context + input => Promise<output>
    assertType<C['getModel']>(
      async (
        _ctx: { identity: { userId: string; principalId: string; orgId?: string } },
        _input: { modelId: string }
      ) => ({ id: '1', name: 'test', provider: 'openai' })
    );

    // healthCheck: empty context => no params
    assertType<C['healthCheck']>(async () => ({ ok: true }));

    expect(true).toBe(true);
  });
});

describe('Contract.ScopedClient', () => {
  test('type-level: scoped client methods omit context', () => {
    type SC = Contract.ScopedClient<TestContractType>;

    // getModel: input only => Promise<output>
    assertType<SC['getModel']>(async (_input: { modelId: string }) => ({
      id: '1',
      name: 'test',
      provider: 'openai',
    }));

    // healthCheck: no params
    assertType<SC['healthCheck']>(async () => ({ ok: true }));

    // noInputUnary: no params (void input, context pre-applied)
    assertType<SC['noInputUnary']>(async () => ({ count: 42 }));

    expect(true).toBe(true);
  });
});

describe('Contract.MethodContext', () => {
  test('type-level: method context resolves correctly', () => {
    // getModel uses contract-level context
    type GetModelCtx = Contract.MethodContext<TestContractType, 'getModel'>;
    assertType<GetModelCtx>({
      identity: { userId: '1', principalId: '2' },
    });

    // healthCheck has empty context override
    type HealthCtx = Contract.MethodContext<TestContractType, 'healthCheck'>;
    const _emptyCtx: HealthCtx = {} as HealthCtx;
    const _keys: keyof HealthCtx = undefined as never;

    expect(true).toBe(true);
  });
});

describe('Contract.Errors', () => {
  test('type-level: errors produce discriminated union', () => {
    type E = Contract.Errors<TestContractType, 'getModel'>;

    // NotFound variant
    assertType<E>({ _tag: 'NotFound', payload: { modelId: '123' } });

    expect(true).toBe(true);
  });

  test('type-level: methods without errors produce never', () => {
    type E = Contract.Errors<TestContractType, 'listModels'>;
    // This type should be `never`, which means no values satisfy it.
    // We can verify by checking the type extends never.
    type IsNever = E extends never ? true : false;
    assertType<IsNever>(true);

    expect(true).toBe(true);
  });
});

describe('streaming method kinds', () => {
  test('type-level: clientStream and duplex have correct handler signatures', () => {
    const StreamContract = Contract.create('stream-svc', {
      version: '1.0.0',
      methods: {
        upload: {
          kind: 'clientStream',
          input: z.object({ chunk: z.string() }),
          output: z.object({ bytesReceived: z.number() }),
        },
        chat: {
          kind: 'duplex',
          input: z.object({ message: z.string() }),
          output: z.object({ reply: z.string() }),
        },
      },
    });

    type SC = typeof StreamContract;
    type H = Contract.Handlers<SC>;

    // clientStream: (inputStream: AsyncIterable<Input>) => Promise<Output>
    assertType<H['upload']>(async (_stream: AsyncIterable<{ chunk: string }>) => ({
      bytesReceived: 100,
    }));

    // duplex: (inputStream: AsyncIterable<Input>) => AsyncIterable<Output>
    assertType<H['chat']>(async function* (_stream: AsyncIterable<{ message: string }>) {
      yield { reply: 'hello' };
    });

    expect(true).toBe(true);
  });
});

describe('contract with no context', () => {
  test('type-level: all methods skip context parameter when contract has no context', () => {
    const NoCtxContract = Contract.create('no-ctx', {
      version: '1.0.0',
      methods: {
        ping: {
          output: z.object({ pong: z.boolean() }),
        },
        echo: {
          input: z.object({ message: z.string() }),
          output: z.object({ message: z.string() }),
        },
      },
    });

    type NC = typeof NoCtxContract;
    type H = Contract.Handlers<NC>;

    // ping: no context, void input => no params
    assertType<H['ping']>(async () => ({ pong: true }));

    // echo: no context, has input => just input param
    assertType<H['echo']>(async (_input: { message: string }) => ({ message: 'hi' }));

    expect(true).toBe(true);
  });
});
