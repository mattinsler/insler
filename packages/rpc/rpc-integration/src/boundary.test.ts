import { describe, expect, test } from 'bun:test';

import { createNatsTransport } from '@insler/rpc-transport-nats';
// @ts-expect-error — the adapter package exports only its root entrypoint; src/ paths must not resolve
import type {} from '@insler/rpc-transport-nats/src/nats-test-harness.js';
import { Client } from '@insler/rpc/client';
import { Contract } from '@insler/rpc/contract';
// The package-boundary contract (subsystem-branding issue 0005): this package
// consumes the rpc subsystem exactly as an external consumer would, so an
// internal (non-public) import must fail VISIBLY. Two guards split the work:
//
// - Deep imports into a package's sources are not in its `exports` map, so
//   they fail typecheck (TS2307) — pinned below with `@ts-expect-error`,
//   which itself errors the moment such a path *starts* resolving.
// - Parent-relative imports escaping into a sibling package's sources would
//   typecheck under the bundler config, so the lint rule owns them
//   (`no-restricted-imports` for `packages/*/*-integration/**`, exercised by
//   scripts/rpc-integration-package.test.ts).
import { Host } from '@insler/rpc/host';
// @ts-expect-error — '@insler/rpc' exports only its public entrypoints; src/ paths must not resolve
import type {} from '@insler/rpc/src/host/index.js';

describe('package boundary', () => {
  test('the public surface resolves as an external consumer sees it', () => {
    expect(typeof Contract.create).toBe('function');
    expect(typeof Client.create).toBe('function');
    expect(typeof Host.create).toBe('function');
    expect(typeof createNatsTransport).toBe('function');
  });
});
