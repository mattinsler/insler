import { diffState, planFingerprint } from './diff.js';
import { renderPlan } from './render.js';
import type {
  ApplyOptions,
  ApplyResult,
  DriftReport,
  Plan,
  Reconciler,
  Resource,
  StateProvider,
} from './types.js';

class ReconcilerImpl implements Reconciler {
  readonly #provider: StateProvider;

  constructor(provider: StateProvider) {
    this.#provider = provider;
  }

  async plan(desired: readonly Resource[]): Promise<Plan> {
    const actual = await this.#provider.getActual();
    return diffState(desired, actual);
  }

  async detectDrift(): Promise<DriftReport> {
    const [actual, lastApplied] = await Promise.all([
      this.#provider.getActual(),
      this.#provider.getLastApplied(),
    ]);
    // The last-applied desired is the baseline; drift is actual diverging from
    // it. The re-converging plan therefore diffs last-applied (desired side)
    // against actual.
    const plan = diffState(lastApplied, actual);
    const drifted = plan.changes.filter((c) => c.action !== 'no-op').map((c) => c.path);
    return { hasDrift: drifted.length > 0, drifted, plan };
  }

  async apply(plan: Plan, options?: ApplyOptions): Promise<ApplyResult> {
    const dryRun = options?.dryRun === true;
    const desired = desiredFromPlan(plan);

    // A plan is keyed to the `(desired, actual)` it was diffed against. If actual
    // has moved on since — a concurrent apply, fresh drift, re-applied
    // declarations — the changeset no longer describes reality, so applying it
    // would clobber the newer state with a stale diff. Re-check the fingerprint
    // against the provider's current actual and reject if it drifted. This guards
    // dry-runs too: a stale preview would show a bogus diff.
    const currentActual = await this.#provider.getActual();
    if (planFingerprint(desired, currentActual) !== plan.fingerprint) {
      throw new Error(
        'stale plan: the actual state changed since this plan was computed; recompute the plan and review again before applying'
      );
    }

    // A dry-run or a converged plan never mutates state. The gated-vs-auto apply
    // policy (#0022/#0023) and the control loop (#0024) wrap this; here apply is
    // an unconditional execution of the plan.
    if (dryRun || plan.isNoOp) {
      return { plan, dryRun, applied: false };
    }
    await this.#provider.setApplied(desired, {
      preserveLastApplied: options?.preserveLastApplied === true,
    });
    return { plan, dryRun, applied: true };
  }

  render(plan: Plan): string {
    return renderPlan(plan);
  }
}

/**
 * Reconstruct the desired-state resource set from a plan: every path that
 * survives (add / change / no-op) with its `after` content; destroys drop out.
 * Used by {@link ReconcilerImpl.apply} to converge actual to desired.
 */
function desiredFromPlan(plan: Plan): readonly Resource[] {
  const resources: Resource[] = [];
  for (const change of plan.changes) {
    if (change.action !== 'destroy' && change.after !== undefined) {
      resources.push({ path: change.path, content: change.after, format: change.format });
    }
  }
  return resources;
}

/**
 * Create the reconciliation engine over a {@link StateProvider}. The provider is
 * the only seam to actual state; the engine itself does no backend I/O. Use
 * `createMemoryStateProvider` for tests and the dev inner loop; real backends
 * implement the same interface later.
 */
export function createReconciler(provider: StateProvider): Reconciler {
  return new ReconcilerImpl(provider);
}
