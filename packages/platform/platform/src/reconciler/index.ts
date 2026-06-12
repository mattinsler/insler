/**
 * `@insler/platform/reconciler` — the Atlas-style plan/diff reconciliation engine.
 *
 * Diffs the generator's desired-state output against a target's actual state and
 * produces a reviewable, versioned {@link Plan} (adds/changes/destroys, no-op
 * when converged), detects drift against the last-applied desired, renders the
 * plan human-readably, and applies it through a {@link StateProvider}.
 *
 * Boundary: consumes `@insler/platform/generator`'s output and depends only on the
 * `FleetManifest` *model* from `@insler/platform/fleet` (transitively, via the
 * generator) — never on fleet's filesystem scanner. Actual state is read
 * through the small {@link StateProvider} seam (`createMemoryStateProvider` is
 * the in-memory fake), so the engine is testable before real backends exist.
 *
 * The engine's `apply` executes a plan without gating. The **production gate**
 * (#0023) layers on top via {@link applyGated}: it admits a plan only if it
 * still matches live actual state (no blind/stale apply) and writes every
 * attempt — applied or rejected — to an {@link AuditSink} with the operator,
 * timestamp, diff, and {@link blastRadius} (the SOC 2 audit trail). Dev
 * auto-converge (#0022) is the ungated counterpart — {@link applyAuto} executes
 * a plan with no gate or audit, the speed path the `insler dev` inner loop
 * stands on. The continuous control loop (#0024) — {@link createControlLoop} —
 * is a further downstream "healing" policy over the same engine: it periodically
 * detects drift, classifies it (replica/config/missing/extra), and either
 * auto-corrects (development; safe categories in production) or alerts, always
 * leaving unmanaged resources alone so it never fights another controller.
 */

export { applyAuto } from './auto.js';
export { blastRadius } from './blast-radius.js';
export { createControlLoop } from './control-loop.js';
export { diffState, toResources } from './diff.js';
export { applyGated } from './gate.js';
export { createMemoryStateProvider } from './provider.js';
export { createReconciler } from './reconciler.js';
export { renderPlan } from './render.js';
export { renderPlanComment } from './render-comment.js';
export type {
  ApplyOptions,
  ApplyResult,
  AuditRecord,
  AutoApplyResult,
  AuditSink,
  BlastRadius,
  ChangeAction,
  ControlLoop,
  ControlLoopMode,
  ControlLoopOptions,
  DriftAction,
  DriftCategory,
  DriftEvent,
  DriftLog,
  DriftLogEntry,
  DriftReport,
  GatedApplyOptions,
  GatedApplyResult,
  MemoryStateProvider,
  Plan,
  PlanSummary,
  Reconciler,
  ReconcileResult,
  Resource,
  ResourceChange,
  SetAppliedOptions,
  StateProvider,
  Ticker,
} from './types.js';
