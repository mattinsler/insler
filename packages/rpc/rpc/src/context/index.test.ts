import { describe, expect, test } from 'bun:test';

import type { Serde } from '@insler/serde';

import { createPropagator } from './create.js';
import type { Propagator } from './propagator.js';

const jsonSerde: Serde<string> = {
  encode: (value) => JSON.stringify(value),
  decode: (wire) => JSON.parse(wire),
};

const propagator = createPropagator(jsonSerde);

describe('createPropagator', () => {
  describe('inject', () => {
    test('serializes string values', () => {
      const carrier: Record<string, string> = {};
      propagator.inject({ name: 'Alice' }, carrier);
      expect(carrier.name).toBe('"Alice"');
    });

    test('serializes object values', () => {
      const carrier: Record<string, string> = {};
      propagator.inject({ identity: { userId: 'u1', orgId: 'o1' } }, carrier);
      expect(carrier.identity).toBe(JSON.stringify({ userId: 'u1', orgId: 'o1' }));
    });

    test('serializes number values', () => {
      const carrier: Record<string, string> = {};
      propagator.inject({ count: 42 }, carrier);
      expect(carrier.count).toBe('42');
    });

    test('serializes boolean values', () => {
      const carrier: Record<string, string> = {};
      propagator.inject({ active: true }, carrier);
      expect(carrier.active).toBe('true');
    });

    test('serializes null values', () => {
      const carrier: Record<string, string> = {};
      propagator.inject({ value: null }, carrier);
      expect(carrier.value).toBe('null');
    });

    test('serializes multiple context keys', () => {
      const carrier: Record<string, string> = {};
      propagator.inject({ identity: { userId: 'u1' }, locale: 'en-US' }, carrier);
      expect(carrier.identity).toBe(JSON.stringify({ userId: 'u1' }));
      expect(carrier.locale).toBe('"en-US"');
    });

    test('preserves existing carrier entries', () => {
      const carrier: Record<string, string> = { traceparent: '00-abc-def-01' };
      propagator.inject({ identity: { userId: 'u1' } }, carrier);
      expect(carrier.traceparent).toBe('00-abc-def-01');
      expect(carrier.identity).toBe(JSON.stringify({ userId: 'u1' }));
    });

    test('does nothing for empty context', () => {
      const carrier: Record<string, string> = { existing: 'value' };
      propagator.inject({}, carrier);
      expect(carrier).toEqual({ existing: 'value' });
    });
  });

  describe('extract', () => {
    test('deserializes string values', () => {
      const carrier = { name: '"Alice"' };
      const result = propagator.extract(['name'], carrier);
      expect(result).toEqual({ name: 'Alice' });
    });

    test('deserializes object values', () => {
      const carrier = { identity: JSON.stringify({ userId: 'u1', orgId: 'o1' }) };
      const result = propagator.extract(['identity'], carrier);
      expect(result).toEqual({ identity: { userId: 'u1', orgId: 'o1' } });
    });

    test('skips keys not present in carrier', () => {
      const carrier: Record<string, string> = {};
      const result = propagator.extract(['identity'], carrier);
      expect(result).toEqual({});
    });

    test('extracts only requested keys', () => {
      const carrier = {
        identity: JSON.stringify({ userId: 'u1' }),
        traceparent: '00-abc-def-01',
        locale: '"en-US"',
      };
      const result = propagator.extract(['identity'], carrier);
      expect(result).toEqual({ identity: { userId: 'u1' } });
    });

    test('extracts multiple keys', () => {
      const carrier = {
        identity: JSON.stringify({ userId: 'u1' }),
        locale: '"en-US"',
      };
      const result = propagator.extract(['identity', 'locale'], carrier);
      expect(result).toEqual({ identity: { userId: 'u1' }, locale: 'en-US' });
    });

    test('returns empty object for empty keys list', () => {
      const carrier = { identity: JSON.stringify({ userId: 'u1' }) };
      const result = propagator.extract([], carrier);
      expect(result).toEqual({});
    });
  });

  describe('roundtrip', () => {
    test('string values roundtrip correctly', () => {
      const carrier: Record<string, string> = {};
      const original = { name: 'Alice' };
      propagator.inject(original, carrier);
      const result = propagator.extract(['name'], carrier);
      expect(result).toEqual(original);
    });

    test('object values roundtrip correctly', () => {
      const carrier: Record<string, string> = {};
      const original = { identity: { userId: 'u1', principalId: 'p1', orgId: 'o1' } };
      propagator.inject(original, carrier);
      const result = propagator.extract(['identity'], carrier);
      expect(result).toEqual(original);
    });

    test('nested objects roundtrip correctly', () => {
      const carrier: Record<string, string> = {};
      const original = {
        identity: {
          user: { id: 'u1', name: 'Alice' },
          permissions: ['read', 'write'],
        },
      };
      propagator.inject(original, carrier);
      const result = propagator.extract(['identity'], carrier);
      expect(result).toEqual(original);
    });

    test('multiple fields roundtrip correctly', () => {
      const carrier: Record<string, string> = {};
      const original = {
        identity: { userId: 'u1' },
        locale: 'en-US',
        flags: { beta: true },
      };
      propagator.inject(original, carrier);
      const result = propagator.extract(['identity', 'locale', 'flags'], carrier);
      expect(result).toEqual(original);
    });

    test('null values roundtrip correctly', () => {
      const carrier: Record<string, string> = {};
      const original = { value: null };
      propagator.inject(original, carrier);
      const result = propagator.extract(['value'], carrier);
      expect(result).toEqual(original);
    });

    test('number values roundtrip correctly', () => {
      const carrier: Record<string, string> = {};
      const original = { count: 42, ratio: 3.14 };
      propagator.inject(original, carrier);
      const result = propagator.extract(['count', 'ratio'], carrier);
      expect(result).toEqual(original);
    });

    test('array values roundtrip correctly', () => {
      const carrier: Record<string, string> = {};
      const original = { tags: ['a', 'b', 'c'] };
      propagator.inject(original, carrier);
      const result = propagator.extract(['tags'], carrier);
      expect(result).toEqual(original);
    });

    test('ambient metadata is preserved alongside context', () => {
      const carrier: Record<string, string> = { traceparent: '00-abc-def-01' };
      const context = { identity: { userId: 'u1' } };
      propagator.inject(context, carrier);

      expect(carrier.traceparent).toBe('00-abc-def-01');

      const extracted = propagator.extract(['identity'], carrier);
      expect(extracted).toEqual(context);
    });
  });
});

describe('createPropagator with different serdes', () => {
  test('works with a base64 serde', () => {
    const base64Serde: Serde<string> = {
      encode: (value) => btoa(JSON.stringify(value)),
      decode: (wire) => JSON.parse(atob(wire)),
    };

    const base64Propagator = createPropagator(base64Serde);
    const carrier: Record<string, string> = {};
    const original = { identity: { userId: 'u1' } };

    base64Propagator.inject(original, carrier);
    expect(carrier.identity).toBe(btoa(JSON.stringify({ userId: 'u1' })));

    const extracted = base64Propagator.extract(['identity'], carrier);
    expect(extracted).toEqual(original);
  });

  test('works with a delimiter serde', () => {
    const delimSerde: Serde<string> = {
      encode: (value) => `<<${JSON.stringify(value)}>>`,
      decode: (wire) => JSON.parse(wire.slice(2, -2)),
    };

    const delimPropagator = createPropagator(delimSerde);
    const carrier: Record<string, string> = {};

    delimPropagator.inject({ name: 'Alice' }, carrier);
    expect(carrier.name).toBe('<<"Alice">>');

    const result = delimPropagator.extract(['name'], carrier);
    expect(result).toEqual({ name: 'Alice' });
  });
});

describe('Propagator interface', () => {
  test('custom propagator can use a prefix namespace', () => {
    const prefixed: Propagator = {
      inject(context, carrier) {
        for (const [key, value] of Object.entries(context)) {
          carrier[`ctx.${key}`] = JSON.stringify(value);
        }
      },
      extract(keys, carrier) {
        const context: Record<string, unknown> = {};
        for (const key of keys) {
          const raw = carrier[`ctx.${key}`];
          if (raw !== undefined) {
            context[key] = JSON.parse(raw);
          }
        }
        return context;
      },
    };

    const carrier: Record<string, string> = { traceparent: '00-abc-def-01' };
    prefixed.inject({ identity: { userId: 'u1' } }, carrier);

    expect(carrier['ctx.identity']).toBe(JSON.stringify({ userId: 'u1' }));
    expect(carrier.traceparent).toBe('00-abc-def-01');
    expect(carrier.identity).toBeUndefined();

    const extracted = prefixed.extract(['identity'], carrier);
    expect(extracted).toEqual({ identity: { userId: 'u1' } });
  });
});
