import { describe, expect, test } from 'bun:test';

import { container, inject, managed, module, singleton, token } from '@insler/di';
// The package-boundary contract (subsystem-branding issue 0007, mirroring
// the rpc template): this package consumes the di subsystem exactly as an
// external consumer would, so an internal (non-public) import must fail
// VISIBLY. Two guards split the work:
//
// - Deep imports into the package's sources are not in its `exports` map, so
//   they fail typecheck (TS2307) — pinned below with `@ts-expect-error`,
//   which itself errors the moment such a path *starts* resolving.
// - Parent-relative imports escaping into the sibling package's sources
//   would typecheck under the bundler config, so the lint rule owns them
//   (`no-restricted-imports` for `packages/*/*-integration/**`, exercised by
//   scripts/di-integration-package.test.ts).
//
// @ts-expect-error — '@insler/di' exports only its root entrypoint; src/ paths must not resolve
import type {} from '@insler/di/src/container.js';

describe('package boundary', () => {
  test('the public surface resolves as an external consumer sees it', () => {
    expect(typeof container).toBe('function');
    expect(typeof token).toBe('function');
    expect(typeof managed).toBe('function');
    expect(typeof singleton).toBe('function');
    expect(typeof module).toBe('function');
    expect(typeof inject).toBe('function');
  });
});
