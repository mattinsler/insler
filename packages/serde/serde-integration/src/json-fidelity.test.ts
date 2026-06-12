import { describe, expect, test } from 'bun:test';

import { jsonBytesSerde, jsonSerde } from '@insler/serde-json';

// Rich-type fidelity of the JSON adapter (subsystem-branding issue 0008):
// @insler/serde-json is SuperJSON-backed, so types plain JSON cannot carry —
// Date, Map, Set, BigInt, RegExp — survive the round-trip through both the
// string and the bytes serde. This is the adapter's headline promise to
// consumers (it is the default lineage of the rpc NATS transport), pinned
// here from the consumer side against built dist.

const rich = {
  at: new Date('2026-06-11T12:00:00.000Z'),
  tags: new Set(['a', 'b']),
  counts: new Map([
    ['x', 1],
    ['y', 2],
  ]),
  big: BigInt('9007199254740993'),
  pattern: /^se(r)de$/gi,
};

function assertRich(decoded: unknown): void {
  const value = decoded as typeof rich;
  expect(value.at).toBeInstanceOf(Date);
  expect(value.at.toISOString()).toBe('2026-06-11T12:00:00.000Z');
  expect(value.tags).toBeInstanceOf(Set);
  expect([...value.tags].sort()).toEqual(['a', 'b']);
  expect(value.counts).toBeInstanceOf(Map);
  expect(value.counts.get('x')).toBe(1);
  expect(value.counts.get('y')).toBe(2);
  expect(value.big).toBe(BigInt('9007199254740993'));
  expect(value.pattern).toBeInstanceOf(RegExp);
  expect(value.pattern.source).toBe('^se(r)de$');
  expect(value.pattern.flags).toBe('gi');
}

describe('rich-type fidelity through @insler/serde-json', () => {
  test('Date, Map, Set, BigInt, and RegExp survive the string serde', () => {
    assertRich(jsonSerde.decode(jsonSerde.encode(rich)));
  });

  test('the same types survive the bytes serde (binary-transport lineage)', () => {
    assertRich(jsonBytesSerde.decode(jsonBytesSerde.encode(rich)));
  });

  test('the bytes serde is the string serde over UTF-8 — non-ASCII text is preserved', () => {
    const value = { text: 'héllo wörld ✓ — 日本語' };
    expect(jsonBytesSerde.decode(jsonBytesSerde.encode(value))).toEqual(value);
  });
});
