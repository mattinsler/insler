import { describe, expect, test } from 'bun:test';

import {
  SERVICE_KINDS,
  Service,
  defineService,
  deriveIdentity,
  resolveIsolation,
  resolveScale,
  serviceKindProfiles,
  validateServiceKind,
} from '@insler/service';
// The package-boundary contract (subsystem-branding issue 0009, mirroring
// the rpc template and the di/serde replications): this package consumes the
// service subsystem exactly as an external consumer would, so an internal
// (non-public) import must fail VISIBLY. Two guards split the work:
//
// - Deep imports into the package's sources are not in its `exports` map, so
//   they fail typecheck (TS2307) — pinned below with `@ts-expect-error`,
//   which itself errors the moment such a path *starts* resolving.
// - Parent-relative imports escaping into the sibling package's sources
//   would typecheck under the bundler config, so the lint rule owns them
//   (`no-restricted-imports` for `packages/*/*-integration/**`, exercised by
//   scripts/service-integration-package.test.ts).
//
// @ts-expect-error — '@insler/service' exports only its root entrypoint; src/ paths must not resolve
import type {} from '@insler/service/src/index.js';
// The in-process pair/client helpers in the package sources are NOT in the
// exports map today (see docs/agents/libraries/service.md) — a consumer
// cannot reach them, so neither can this suite.
// @ts-expect-error — '@insler/service/test' is not a published subpath; it must not resolve
import type {} from '@insler/service/test';

describe('package boundary', () => {
  test('the public surface resolves as an external consumer sees it', () => {
    // Both roles of the single root entrypoint: the env-aware runtime
    // wrapper and the deployment-intent declaration model.
    expect(typeof Service.create).toBe('function');
    expect(typeof defineService).toBe('function');
    expect(typeof deriveIdentity).toBe('function');
    expect(typeof validateServiceKind).toBe('function');
    expect(typeof resolveScale).toBe('function');
    expect(typeof resolveIsolation).toBe('function');
    expect(SERVICE_KINDS).toEqual(['ephemeral', 'persistent', 'workflow']);
    expect(Object.keys(serviceKindProfiles).sort()).toEqual([
      'ephemeral',
      'persistent',
      'workflow',
    ]);
  });
});
