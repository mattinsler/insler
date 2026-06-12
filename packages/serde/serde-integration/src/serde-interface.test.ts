import { describe, expect, test } from 'bun:test';

import type { Serde } from '@insler/serde';
import { createAvroSerde } from '@insler/serde-avro';
import { cborSerde } from '@insler/serde-cbor';
import { jsonBytesSerde, jsonSerde } from '@insler/serde-json';
import { msgpackSerde } from '@insler/serde-msgpack';
import { expectTypeOf } from 'expect-type';

// The umbrella contract from the consumer side (subsystem-branding issue
// 0008): `@insler/serde` publishes the `Serde<Wire>` interface — the one
// contract every adapter implements and every transport accepts. A consumer
// implements it to add a format and relies on `Wire` being the only knob, so
// the suite pins both directions: a hand-written implementation satisfies the
// interface, and every published adapter is assignable to it.

describe('the Serde<Wire> interface as a consumer implements it', () => {
  test('a custom implementation satisfies the interface and round-trips', () => {
    // The simplest conforming serde a consumer would write — plain JSON with
    // the undefined <-> empty-wire convention the docs prescribe.
    const plainJson: Serde<string> = {
      encode(value: unknown): string {
        return value === undefined ? '' : JSON.stringify(value);
      },
      decode(wire: string): unknown {
        return wire === '' ? undefined : JSON.parse(wire);
      },
    };

    expect(plainJson.decode(plainJson.encode({ a: 1, b: [true, 'x'] }))).toEqual({
      a: 1,
      b: [true, 'x'],
    });
    expect(plainJson.encode(undefined)).toBe('');
    expect(plainJson.decode('')).toBeUndefined();
  });

  test('type surface: Wire is the only knob — encode takes unknown, decode returns unknown', () => {
    expectTypeOf<Serde<string>['encode']>().parameter(0).toEqualTypeOf<unknown>();
    expectTypeOf<Serde<string>['encode']>().returns.toEqualTypeOf<string>();
    expectTypeOf<Serde<string>['decode']>().parameter(0).toEqualTypeOf<string>();
    expectTypeOf<Serde<string>['decode']>().returns.toEqualTypeOf<unknown>();
    // The default Wire is unknown.
    expectTypeOf<Serde['encode']>().returns.toEqualTypeOf<unknown>();
  });

  test('type surface: a serde of one wire type must reject another (a transport cannot mix them)', () => {
    // A binary transport takes Serde<Uint8Array>; the string serde must not
    // satisfy it.
    function useBinary(_serde: Serde<Uint8Array>): void {}
    useBinary(cborSerde);
    // @ts-expect-error jsonSerde is Serde<string>, not Serde<Uint8Array>
    useBinary(jsonSerde);
  });
});

describe('every published adapter implements the umbrella interface', () => {
  test('type surface: adapters are assignable to their declared Serde<Wire>', () => {
    expectTypeOf(jsonSerde).toMatchTypeOf<Serde<string>>();
    expectTypeOf(jsonBytesSerde).toMatchTypeOf<Serde<Uint8Array>>();
    expectTypeOf(cborSerde).toMatchTypeOf<Serde<Uint8Array>>();
    expectTypeOf(msgpackSerde).toMatchTypeOf<Serde<Uint8Array>>();
    expectTypeOf(createAvroSerde('string')).toMatchTypeOf<Serde<Uint8Array>>();
  });

  test('the binary adapters are interchangeable behind one Serde<Uint8Array> seam', () => {
    // The reason the interface exists: a consumer (e.g. a transport's `serde`
    // option) can swap formats without touching call sites.
    const formats: Serde<Uint8Array>[] = [jsonBytesSerde, cborSerde, msgpackSerde];
    const value = { id: 'abc', n: 7, ok: true };
    for (const serde of formats) {
      expect(serde.decode(serde.encode(value))).toEqual(value);
    }
  });
});
