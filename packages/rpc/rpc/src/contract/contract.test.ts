import { describe, expect, test } from 'bun:test';

import { z } from 'zod';

import { Contract } from './index.js';

const IdentitySchema = z.object({
  userId: z.string(),
  principalId: z.string(),
  orgId: z.string().optional(),
});

const ModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  createdAt: z.date(),
});

const ModelNotFoundPayload = z.object({ modelId: z.string() });

describe('Contract.create()', () => {
  test('returns a frozen object', () => {
    const contract = Contract.create('test-service', {
      version: '1.0.0',
      methods: {},
    });

    expect(Object.isFrozen(contract)).toBe(true);
    expect(() => {
      (contract as any).kind = 'changed';
    }).toThrow();
  });

  test('has correct type and kind', () => {
    const contract = Contract.create('my-service', {
      version: '2.0.0',
      methods: {},
    });

    expect(contract.type).toBe('contract');
    expect(contract.kind).toBe('my-service');
    expect(contract.version).toBe('2.0.0');
  });

  test('defaults context to empty object when not provided', () => {
    const contract = Contract.create('svc', {
      version: '1.0.0',
      methods: {},
    });

    expect(contract.context).toEqual({});
  });

  test('preserves context when provided', () => {
    const contract = Contract.create('svc', {
      version: '1.0.0',
      context: { identity: IdentitySchema },
      methods: {},
    });

    expect(contract.context.identity).toBe(IdentitySchema);
  });

  test('normalizes method defaults', () => {
    const contract = Contract.create('svc', {
      version: '1.0.0',
      methods: {
        doSomething: {},
      },
    });

    const method = contract.methods.doSomething;
    expect(method.name).toBe('doSomething');
    expect(method.kind).toBe('unary');
    expect(method.input).toBeDefined();
    expect(method.output).toBeDefined();
    expect(method.errors).toBeUndefined();
    expect(method.context).toBeUndefined();
    expect(method.description).toBeUndefined();
  });

  test('preserves explicit method properties', () => {
    const input = z.object({ modelId: z.string() });
    const output = ModelSchema;

    const contract = Contract.create('svc', {
      version: '1.0.0',
      context: { identity: IdentitySchema },
      methods: {
        getModel: {
          kind: 'unary',
          description: 'Get a model by ID.',
          input,
          output,
          errors: { NotFound: ModelNotFoundPayload },
        },
      },
    });

    const method = contract.methods.getModel;
    expect(method.name).toBe('getModel');
    expect(method.kind).toBe('unary');
    expect(method.description).toBe('Get a model by ID.');
    expect(method.input).toBe(input);
    expect(method.output).toBe(output);
    expect(method.errors).toEqual({ NotFound: ModelNotFoundPayload });
  });

  test('preserves serverStream kind', () => {
    const contract = Contract.create('svc', {
      version: '1.0.0',
      methods: {
        watchModels: {
          kind: 'serverStream',
          output: ModelSchema,
        },
      },
    });

    expect(contract.methods.watchModels.kind).toBe('serverStream');
  });

  test('preserves per-method context override', () => {
    const contract = Contract.create('svc', {
      version: '1.0.0',
      context: { identity: IdentitySchema },
      methods: {
        healthCheck: {
          context: {},
          input: z.void(),
          output: z.object({ ok: z.boolean() }),
        },
      },
    });

    expect(contract.methods.healthCheck.context).toEqual({});
  });

  test('methods object is frozen', () => {
    const contract = Contract.create('svc', {
      version: '1.0.0',
      methods: {
        foo: { output: z.string() },
      },
    });

    expect(Object.isFrozen(contract.methods)).toBe(true);
  });

  test('each method is frozen', () => {
    const contract = Contract.create('svc', {
      version: '1.0.0',
      methods: {
        foo: { output: z.string() },
      },
    });

    expect(Object.isFrozen(contract.methods.foo)).toBe(true);
    expect(() => {
      (contract.methods.foo as any).name = 'changed';
    }).toThrow();
  });

  test('methodList is a frozen array matching methods', () => {
    const contract = Contract.create('svc', {
      version: '1.0.0',
      methods: {
        alpha: { output: z.string() },
        beta: { kind: 'serverStream', output: z.number() },
      },
    });

    expect(Object.isFrozen(contract.methodList)).toBe(true);
    expect(contract.methodList).toHaveLength(2);

    const names = contract.methodList.map((m) => m.name);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
  });

  test('schemas are preserved when provided', () => {
    const contract = Contract.create('svc', {
      version: '1.0.0',
      methods: {},
      schemas: { Model: ModelSchema },
    });

    expect(contract.schemas).toEqual({ Model: ModelSchema });
  });

  test('schemas are undefined when not provided', () => {
    const contract = Contract.create('svc', {
      version: '1.0.0',
      methods: {},
    });

    expect(contract.schemas).toBeUndefined();
  });

  test('full example matches expected shape', () => {
    const contract = Contract.create('model-registry', {
      version: '1.0.0',
      context: {
        identity: IdentitySchema,
      },
      methods: {
        getModel: {
          kind: 'unary',
          description: 'Get a model by ID.',
          input: z.object({ modelId: z.string() }),
          output: ModelSchema,
          errors: { NotFound: ModelNotFoundPayload },
        },
        listModels: {
          kind: 'unary',
          input: z.object({ provider: z.string().optional() }).optional(),
          output: z.object({ data: z.array(ModelSchema) }),
        },
        watchModels: {
          kind: 'serverStream',
          description: 'Watch for model changes.',
          output: ModelSchema,
        },
        healthCheck: {
          context: {},
          input: z.void(),
          output: z.object({ ok: z.boolean() }),
        },
      },
    });

    expect(contract.type).toBe('contract');
    expect(contract.kind).toBe('model-registry');
    expect(contract.version).toBe('1.0.0');
    expect(Object.keys(contract.methods)).toHaveLength(4);
    expect(contract.methodList).toHaveLength(4);
    expect(contract.methods.getModel.kind).toBe('unary');
    expect(contract.methods.listModels.kind).toBe('unary');
    expect(contract.methods.watchModels.kind).toBe('serverStream');
    expect(contract.methods.healthCheck.kind).toBe('unary');
    expect(contract.methods.healthCheck.context).toEqual({});
  });
});
