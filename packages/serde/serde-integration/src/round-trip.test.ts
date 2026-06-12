import { describe, expect, test } from 'bun:test';

import type { Serde } from '@insler/serde';
import { cborSerde } from '@insler/serde-cbor';
import { jsonBytesSerde, jsonSerde } from '@insler/serde-json';
import { msgpackSerde } from '@insler/serde-msgpack';

// The serde subsystem's tracer-bullet integration test (subsystem-branding
// issue 0008): cross-adapter round-trip behavior through the public
// entrypoints, consuming the subsystem exactly as an external consumer would
// — published adapter packages resolved to built dist output (run `bun run
// build` first). serde is in-process serialization, so like the di
// replication no infrastructure is provisioned: the suite IS the consumer.
// Assertions are the values the consumer gets back, never wire bytes — wire
// layout is each format library's business.

// A payload exercising strings (incl. non-ASCII), floats, negatives,
// booleans, null, arrays, and nesting — shapes every schemaless adapter must
// round-trip identically.
const payload = {
  text: 'héllo wörld ✓',
  n: 1234.5625,
  flag: true,
  nothing: null,
  list: [1, 2.5, -3],
  nested: { inner: 'deep value', tags: ['a', 'b'] },
};

// Every published schemaless adapter, with its wire type. (Avro is
// schema-required and covered in avro.test.ts.)
const stringAdapters: [string, Serde<string>][] = [['@insler/serde-json jsonSerde', jsonSerde]];
const bytesAdapters: [string, Serde<Uint8Array>][] = [
  ['@insler/serde-json jsonBytesSerde', jsonBytesSerde],
  ['@insler/serde-cbor cborSerde', cborSerde],
  ['@insler/serde-msgpack msgpackSerde', msgpackSerde],
];

describe.each([...stringAdapters, ...bytesAdapters] as [string, Serde<any>][])(
  'round-trip through the published adapter — %s',
  (_name, serde) => {
    test('a structured payload comes back identical', () => {
      expect(serde.decode(serde.encode(payload))).toEqual(payload);
    });

    test('primitives come back identical', () => {
      expect(serde.decode(serde.encode('plain string'))).toBe('plain string');
      expect(serde.decode(serde.encode(42))).toBe(42);
      expect(serde.decode(serde.encode(false))).toBe(false);
      expect(serde.decode(serde.encode(null))).toBeNull();
    });

    test('empty containers survive', () => {
      expect(serde.decode(serde.encode({}))).toEqual({});
      expect(serde.decode(serde.encode([]))).toEqual([]);
    });
  }
);

describe('the undefined <-> empty-wire contract (the serde guide pins it for every impl)', () => {
  test('jsonSerde: encode(undefined) is the empty string; decode("") is undefined', () => {
    expect(jsonSerde.encode(undefined)).toBe('');
    expect(jsonSerde.decode('')).toBeUndefined();
  });

  test.each(bytesAdapters)(
    '%s: encode(undefined) is empty bytes; decode(empty) is undefined',
    (_name, serde) => {
      const wire = serde.encode(undefined);
      expect(wire).toBeInstanceOf(Uint8Array);
      expect(wire.length).toBe(0);
      expect(serde.decode(new Uint8Array(0))).toBeUndefined();
    }
  );
});

describe('cross-adapter independence', () => {
  test('each adapter decodes only its own wire — formats never share encoded state', () => {
    // Encode once per binary format and decode each wire with its own
    // adapter: three independent wires, one identical consumer value.
    const wires = bytesAdapters.map(([, serde]) => serde.encode(payload));
    bytesAdapters.forEach(([, serde], i) => {
      expect(serde.decode(wires[i] as Uint8Array)).toEqual(payload);
    });
  });
});
