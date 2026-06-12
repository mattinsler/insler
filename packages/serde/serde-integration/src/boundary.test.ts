import { describe, expect, test } from 'bun:test';

import type { Serde } from '@insler/serde';
import { createAvroSerde } from '@insler/serde-avro';
import { cborSerde } from '@insler/serde-cbor';
import { jsonBytesSerde, jsonSerde } from '@insler/serde-json';
import { msgpackSerde } from '@insler/serde-msgpack';
// The package-boundary contract (subsystem-branding issue 0008, mirroring
// the rpc template and the di replication): this package consumes the serde
// subsystem exactly as an external consumer would, so an internal
// (non-public) import must fail VISIBLY. Two guards split the work:
//
// - Deep imports into a package's sources are not in its `exports` map, so
//   they fail typecheck (TS2307) — pinned below with `@ts-expect-error`,
//   which itself errors the moment such a path *starts* resolving.
// - Parent-relative imports escaping into a sibling package's sources
//   would typecheck under the bundler config, so the lint rule owns them
//   (`no-restricted-imports` for `packages/*/*-integration/**`, exercised by
//   scripts/serde-integration-package.test.ts).
//
// @ts-expect-error — '@insler/serde' exports only its root entrypoint; src/ paths must not resolve
import type {} from '@insler/serde/src/serde.js';

describe('package boundary', () => {
  test('the public surface resolves as an external consumer sees it', () => {
    // The umbrella's runtime surface is the Serde interface (type-only); the
    // working implementations are the adapter packages.
    const custom: Serde<string> = { encode: (v) => JSON.stringify(v) ?? '', decode: (w) => w };
    expect(typeof custom.encode).toBe('function');
    expect(typeof jsonSerde.encode).toBe('function');
    expect(typeof jsonBytesSerde.encode).toBe('function');
    expect(typeof cborSerde.encode).toBe('function');
    expect(typeof msgpackSerde.encode).toBe('function');
    expect(typeof createAvroSerde).toBe('function');
  });
});
