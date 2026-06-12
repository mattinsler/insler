import type { AutoApplyResult, Plan, Reconciler } from './types.js';

/**
 * The ungated auto-apply primitive (issue 0022) — the dev-only counterpart to
 * the production gate ({@link applyGated}, 0023). It executes a plan through the
 * engine's `apply` with **no review, no operator, and no audit trail**: the
 * speed path the development inner loop's auto-converge (`insler dev`) stands
 * on, where saving a declaration applies immediately.
 *
 * It deliberately keeps the engine's stale-plan guard (issue 0028): a plan keyed
 * to an actual state that has since moved on is still refused (the engine
 * throws), because applying a stale diff would clobber newer state — that risk
 * is independent of whether a human gate is in the way. What this primitive
 * drops, relative to the gate, is the plan-match *policy* and the audit record;
 * it never gates a change behind approval.
 *
 * Boundary: this is engine-only. It depends solely on the {@link Reconciler}
 * interface and the fleet *model* (transitively) — never on fleet's scanner. The
 * watch → re-scan → re-generate orchestration that drives it lives one layer up,
 * in `@insler/cli` (`insler dev`).
 */
export async function applyAuto(reconciler: Reconciler, plan: Plan): Promise<AutoApplyResult> {
  const apply = await reconciler.apply(plan);
  return { plan, applied: apply.applied, summary: plan.summary };
}
