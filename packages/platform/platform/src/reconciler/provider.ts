import type { MemoryStateProvider, Resource, SetAppliedOptions } from './types.js';

/** Defensive copy so callers can't mutate the provider's internal state. */
function clone(resources: readonly Resource[]): Resource[] {
  return resources.map((res) => ({ ...res }));
}

/**
 * An in-memory {@link StateProvider} — the testable fake the engine reconciles
 * against while real backends (Kubernetes, serverless) do not yet exist. Holds
 * `actual` and `lastApplied` independently so a test can model pre-existing
 * drift (seed them differently); a successful apply sets both to the desired set
 * (only `actual` when the write carries `preserveLastApplied` — a drift
 * correction converging the world without rewriting intent).
 *
 * Beyond the {@link StateProvider} seam it exposes {@link MemoryStateProvider.driftActual}:
 * a test-only mutation of *live* state that leaves last-applied untouched — the
 * way out-of-band drift actually arises (a manual scale, an edited ConfigMap),
 * so control-loop tests can inject fresh drift between passes deterministically
 * without a real backend.
 *
 * @param actual seed for the live state (defaults to empty).
 * @param lastApplied seed for the last-applied desired (defaults to `actual`).
 */
export function createMemoryStateProvider(
  actual: readonly Resource[] = [],
  lastApplied?: readonly Resource[]
): MemoryStateProvider {
  let current = clone(actual);
  let applied = clone(lastApplied ?? actual);

  return {
    getActual(): Promise<readonly Resource[]> {
      return Promise.resolve(clone(current));
    },
    getLastApplied(): Promise<readonly Resource[]> {
      return Promise.resolve(clone(applied));
    },
    setApplied(desired: readonly Resource[], options?: SetAppliedOptions): Promise<void> {
      current = clone(desired);
      if (options?.preserveLastApplied !== true) {
        applied = clone(desired);
      }
      return Promise.resolve();
    },
    driftActual(live: readonly Resource[]): Promise<void> {
      current = clone(live);
      return Promise.resolve();
    },
  };
}
