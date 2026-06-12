import type { GeneratedFileFormat } from '../generator/index.js';

/**
 * `@insler/platform/reconciler` is the Atlas-style plan/diff engine. It diffs the
 * **desired state** — the deterministic artifact set the generator (#0011)
 * derives from a {@link FleetManifest} — against the **actual state** of a
 * target and produces a reviewable {@link Plan}: a versioned changeset of
 * adds/changes/destroys that can be reviewed, audited, and applied.
 *
 * Boundary: this package consumes the generator's desired-state output and
 * depends only on the `FleetManifest` *model* from `@insler/platform/fleet` (via the
 * generator), never on fleet's filesystem scanner. The reconciler never reads
 * declarations from disk — a caller brings the desired state in.
 *
 * Real "actual state" backends (Kubernetes, serverless, …) do not exist yet, so
 * the actual state is read through a small {@link StateProvider} seam that can
 * be backed by an in-memory fake for tests and, later, by real backends.
 */

/**
 * A single unit of managed state, addressed by `path`. Desired state is the set
 * of resources the generator emits (one per {@link GeneratedFile}); actual state
 * is the set a {@link StateProvider} reports. `content` is the rendered body the
 * diff compares; `format` is carried through so a renderer/applier need not
 * re-sniff it.
 */
export interface Resource {
  /** Stable identity of the resource within a state set. */
  readonly path: string;
  /** The rendered body that desired-vs-actual equality is decided on. */
  readonly content: string;
  /** The resource's on-disk format (mirrors the generator's). */
  readonly format: GeneratedFileFormat;
}

/**
 * What reconciling one resource will do. `add` = present in desired, absent in
 * actual; `change` = present in both with differing content; `destroy` =
 * present in actual, absent in desired; `no-op` = present in both, identical.
 */
export type ChangeAction = 'add' | 'change' | 'destroy' | 'no-op';

/**
 * The reconciliation verdict for one resource path. `before` is the actual
 * content (absent for an `add`); `after` is the desired content (absent for a
 * `destroy`). Carries `format` for rendering. Plain data — JSON-serializable for
 * the audit log (AC5).
 */
export interface ResourceChange {
  /** The action reconciling this path will take. */
  readonly action: ChangeAction;
  /** The resource path this change concerns. */
  readonly path: string;
  /** The resource format (from whichever side is present). */
  readonly format: GeneratedFileFormat;
  /** Actual content before the change; absent for an `add`. */
  readonly before?: string;
  /** Desired content after the change; absent for a `destroy`. */
  readonly after?: string;
}

/** Counts of each consequential action in a {@link Plan}. */
export interface PlanSummary {
  /** Resources to create. */
  readonly add: number;
  /** Resources to update in place. */
  readonly change: number;
  /** Resources to remove. */
  readonly destroy: number;
}

/**
 * A reviewable, versioned changeset between desired and actual state — the
 * first-class artifact of the engine (AC1). Every path appears exactly once, in
 * a deterministic order, so two plans over equal inputs are byte-identical.
 * `isNoOp` is true iff every change is a `no-op` (AC3). Plain data, so it
 * round-trips through `JSON.stringify` for audit logging (AC5).
 */
export interface Plan {
  /** Every reconciled path, including `no-op`s, in stable path order. */
  readonly changes: readonly ResourceChange[];
  /** Counts of the consequential actions (excludes `no-op`s). */
  readonly summary: PlanSummary;
  /** True when desired and actual are converged — nothing to apply (AC3). */
  readonly isNoOp: boolean;
  /**
   * A fingerprint of the `(desired, actual)` inputs this plan was computed from.
   * A plan is only safe to apply against the same actual state it was diffed
   * against; if actual moved on (a concurrent apply, fresh drift, re-applied
   * declarations) the recorded changeset no longer describes reality. `apply`
   * recomputes this fingerprint against the provider's *current* actual and
   * rejects the plan as stale on a mismatch — optimistic concurrency over the
   * `StateProvider` seam, in the spirit of an Atlas plan keyed to a known base.
   */
  readonly fingerprint: string;
}

/**
 * The verdict of comparing actual state against the *last-applied desired*
 * state (AC4). Drift is actual diverging from what was last applied — a
 * resource changed or vanished out-of-band. `hasDrift` is true iff any drifted
 * path exists. The embedded {@link Plan} is the diff that would re-converge
 * actual back to the last-applied desired.
 */
export interface DriftReport {
  /** True when actual differs from the last-applied desired state. */
  readonly hasDrift: boolean;
  /** Paths whose actual content/presence differs from last-applied. */
  readonly drifted: readonly string[];
  /** The plan that would bring actual back to the last-applied desired. */
  readonly plan: Plan;
}

/** Options for a {@link StateProvider.setApplied} write. */
export interface SetAppliedOptions {
  /**
   * Update actual state only, leaving the recorded last-applied desired as it
   * was. A drift correction (issue 0024) converges actual back toward the
   * existing intent — its desired set carries live content for resources it
   * must not touch (unmanaged extras, alert-only drift), so recording that set
   * would adopt them as intent and mask them from future drift detection.
   */
  readonly preserveLastApplied?: boolean;
}

/**
 * The seam over a target's actual state. The reconciler reads actual state and,
 * on apply, records the new last-applied desired through this interface; it
 * never reaches a backend directly. An in-memory implementation backs tests;
 * real backends (K8s, serverless) implement the same three methods later.
 */
export interface StateProvider {
  /** The actual resources currently live on the target. */
  getActual(): Promise<readonly Resource[]>;
  /** The desired state recorded by the last successful apply (for drift). */
  getLastApplied(): Promise<readonly Resource[]>;
  /**
   * Persist `desired` as both the new actual and the new last-applied (only
   * the new actual with {@link SetAppliedOptions.preserveLastApplied}).
   */
  setApplied(desired: readonly Resource[], options?: SetAppliedOptions): Promise<void>;
}

/**
 * The in-memory {@link StateProvider} (`createMemoryStateProvider`). Beyond the
 * seam it adds {@link MemoryStateProvider.driftActual}: a test-only mutation of
 * live state that leaves last-applied untouched, so a test can model out-of-band
 * drift (a manual scale, an edited ConfigMap) arriving between control-loop
 * passes — deterministically, with no real backend.
 */
export interface MemoryStateProvider extends StateProvider {
  /** Mutate live actual state only (leaving last-applied) to inject drift. */
  driftActual(live: readonly Resource[]): Promise<void>;
}

/**
 * The blast radius of a {@link Plan} (issue 0023 AC3): how much of the fleet a
 * production change touches, surfaced for review before an operator applies it.
 * `resourcesChanged` is the count of consequential changes (excludes no-ops);
 * `servicesAffected` is the distinct, sorted set of services those changes hit
 * (derived from each resource path's leading segment). Plain data so it stores
 * in the audit trail alongside the plan.
 */
export interface BlastRadius {
  /** Distinct services touched by the plan, sorted; empty for a no-op plan. */
  readonly servicesAffected: readonly string[];
  /** Count of consequential resource changes (add + change + destroy). */
  readonly resourcesChanged: number;
  /** The underlying action counts, carried through for review. */
  readonly summary: PlanSummary;
}

/**
 * One entry in the production audit trail (issue 0023 AC4/AC6). Every gated
 * apply attempt — accepted or rejected — produces a record: who triggered it
 * (`operator`), when (`timestamp`, ISO-8601), what would change (`plan` +
 * `blastRadius`), and the verdict (`outcome`, with a `reason` on rejection).
 * Plain, JSON-serializable data — load-bearing for SOC 2, so it must round-trip
 * through `JSON.stringify` into whatever durable store backs the {@link AuditSink}.
 */
export interface AuditRecord {
  /** Whether the plan was applied or rejected. */
  readonly outcome: 'applied' | 'rejected';
  /** The identity that triggered the apply (operator or CI principal). */
  readonly operator: string;
  /** ISO-8601 timestamp of the attempt. */
  readonly timestamp: string;
  /** The plan (diff) the attempt concerned — the reviewable artifact. */
  readonly plan: Plan;
  /** The blast radius of that plan, denormalized for at-a-glance audit. */
  readonly blastRadius: BlastRadius;
  /** Why a rejected attempt was refused (e.g. a stale plan); absent when applied. */
  readonly reason?: string;
}

/**
 * The seam over the durable audit store (issue 0023). The gate writes one
 * {@link AuditRecord} per apply attempt through this single method; an in-memory
 * implementation backs tests and a file/append-only backend backs the CLI. The
 * engine never writes to a store directly.
 */
export interface AuditSink {
  /** Persist one audit record. */
  record(entry: AuditRecord): Promise<void>;
}

/** Options for an {@link applyGated} call — the production apply policy (0023). */
export interface GatedApplyOptions {
  /** The identity to attribute the apply to in the audit trail (required). */
  readonly operator: string;
  /** Where the accepted/rejected audit record is written (required). */
  readonly audit: AuditSink;
  /** Clock seam for the audit timestamp; defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

/**
 * The verdict of a gated apply (issue 0023). `applied` carries the engine's
 * {@link ApplyResult}; `rejected` carries the `reason` (e.g. a stale plan) and
 * persists nothing. Either way an {@link AuditRecord} was written.
 */
export interface GatedApplyResult {
  /** Whether the gate applied the plan or refused it. */
  readonly outcome: 'applied' | 'rejected';
  /** The audit record written for this attempt. */
  readonly audit: AuditRecord;
  /** The engine apply outcome — present only when `outcome` is `applied`. */
  readonly apply?: ApplyResult;
  /** Why the gate refused — present only when `outcome` is `rejected`. */
  readonly reason?: string;
}

/**
 * The verdict of an ungated auto-apply (issue 0022) — the dev-only counterpart
 * to {@link GatedApplyResult}. There is no operator, no audit record, and no
 * plan-match policy: dev auto-converge trades the production gate for speed.
 * `summary` is denormalized from the plan so a caller (the `insler dev` loop)
 * can report what changed without re-deriving it.
 */
export interface AutoApplyResult {
  /** The plan that was applied. */
  readonly plan: Plan;
  /** True when state was mutated (false for a no-op/converged plan). */
  readonly applied: boolean;
  /** Counts of the consequential actions applied (excludes no-ops). */
  readonly summary: PlanSummary;
}

/**
 * The category of one drifted resource (issue 0024). Mirrors the issue's drift
 * table, derived from the drift {@link Plan} (last-applied desired vs actual):
 *
 * - `replica-count` — a managed resource changed and *only* its replica count
 *   differs (a manual scale). The cheapest, safest correction.
 * - `config-drift` — a managed resource changed in some other field (e.g. an
 *   edited ConfigMap).
 * - `missing-resource` — a managed resource present in last-applied is absent
 *   from actual (it was deleted out-of-band).
 * - `extra-resource` — a resource present in actual is absent from last-applied:
 *   we do not own it. The loop only ever alerts on these — correcting one would
 *   fight whatever controller created it (AC7).
 */
export type DriftCategory =
  | 'replica-count'
  | 'config-drift'
  | 'missing-resource'
  | 'extra-resource';

/**
 * What the control loop decided to do about one {@link DriftEvent}: `corrected`
 * means the loop converged the resource back toward intent; `alerted` means it
 * only surfaced the drift (production policy, or an unmanaged extra resource it
 * must not touch). Every event resolves to exactly one of these (AC5).
 */
export type DriftAction = 'corrected' | 'alerted';

/**
 * One detected drift, classified (issue 0024 AC2/AC6). Plain, JSON-serializable
 * data so it logs cleanly. `managed` distinguishes resources the platform owns
 * (in last-applied desired) from `extra-resource` drift it does not (AC6/AC7).
 */
export interface DriftEvent {
  /** The drifted resource path. */
  readonly path: string;
  /** The drift category, from the issue's table. */
  readonly category: DriftCategory;
  /** The underlying diff action (`add`/`change`/`destroy`) that surfaced it. */
  readonly action: ChangeAction;
  /** Whether the platform owns this resource (false only for `extra-resource`). */
  readonly managed: boolean;
  /** Actual content before any correction; absent for a `missing-resource`. */
  readonly before?: string;
  /** Intended content; absent for an `extra-resource`. */
  readonly after?: string;
}

/**
 * One line of the drift log (AC5): the {@link DriftEvent}, the {@link DriftAction}
 * the loop took, and an ISO-8601 timestamp. JSON-serializable for whatever sink
 * persists the trail. Every drift event in a pass produces exactly one entry.
 */
export interface DriftLogEntry {
  /** The drift this entry concerns. */
  readonly event: DriftEvent;
  /** Whether the loop corrected or merely alerted. */
  readonly action: DriftAction;
  /** ISO-8601 timestamp of the reconciliation pass. */
  readonly timestamp: string;
}

/**
 * The sink the control loop writes drift events and corrections to (AC5). One
 * {@link DriftLogEntry} per event per pass. An in-memory implementation backs
 * tests; a structured-logger or alerting backend backs production later. The
 * loop never logs directly.
 */
export interface DriftLog {
  /** Persist one drift log entry. */
  record(entry: DriftLogEntry): void;
}

/**
 * The environment the control loop runs under (issue 0024). `development`
 * auto-corrects all correctable drift; `production` is conservative — it alerts
 * and only auto-corrects the safe categories, and only when explicitly enabled.
 */
export type ControlLoopMode = 'development' | 'production';

/** Configuration for a {@link ControlLoop} (issue 0024). */
export interface ControlLoopOptions {
  /** Whether the loop is correcting development or production state. */
  readonly mode: ControlLoopMode;
  /**
   * In `production`, also auto-correct the *safe* drift categories
   * (`replica-count`, `config-drift`) rather than only alerting. `missing-resource`
   * is "alert first" and never auto-corrected in production; `extra-resource` is
   * never corrected in any mode (AC4). Ignored in `development` (which always
   * corrects). Defaults to `false`.
   */
  readonly autoCorrectSafeInProduction?: boolean;
  /** Where drift events + corrections are logged (AC5). Required. */
  readonly log: DriftLog;
  /** Clock seam for log timestamps; defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

/**
 * The outcome of one reconciliation pass (issue 0024). `events` is every drift
 * detected this pass (empty when converged); `corrected`/`alerted` partition
 * them by the action taken; `applied` is true iff the loop mutated state. The
 * `log` entries written this pass are surfaced for the caller/tests (AC5).
 */
export interface ReconcileResult {
  /** Every drift detected this pass, classified. */
  readonly events: readonly DriftEvent[];
  /** The subset of `events` the loop corrected. */
  readonly corrected: readonly DriftEvent[];
  /** The subset of `events` the loop only alerted on. */
  readonly alerted: readonly DriftEvent[];
  /** True when the pass mutated state (corrected at least one resource). */
  readonly applied: boolean;
  /** The log entries written this pass — one per event. */
  readonly log: readonly DriftLogEntry[];
}

/**
 * A periodic driver for the control loop (issue 0024). The loop never reaches
 * for a real `setInterval`/`sleep`; it `await`s `next()` between passes, so tests
 * drive it with a deterministic, injectable ticker (no wall-clock flakiness).
 * `next()` resolves once per tick; resolving `false` (or an exhausted ticker)
 * stops the loop. A real interval-backed ticker is supplied by the CLI.
 */
export interface Ticker {
  /** Resolve to start the next pass, or `false`/`void` to stop the loop. */
  next(): Promise<boolean | void>;
}

/**
 * The continuous reconciliation control loop (issue 0024) — a policy *over* the
 * engine, never a replacement for it. `reconcileOnce` runs exactly one pass
 * (detect drift, classify, correct-or-alert per mode, log) and is the hermetic
 * unit tests drive directly. `run` repeats `reconcileOnce` once per {@link Ticker}
 * tick until the ticker stops, returning every pass's result in order.
 */
export interface ControlLoop {
  /** Run one pass: detect, classify, correct/alert, log. Returns its result. */
  reconcileOnce(): Promise<ReconcileResult>;
  /** Drive `reconcileOnce` once per ticker tick until the ticker stops. */
  run(ticker: Ticker): Promise<readonly ReconcileResult[]>;
}

/** Outcome of executing a {@link Plan} against a {@link StateProvider} (AC7). */
export interface ApplyResult {
  /** The plan that was applied (or previewed). */
  readonly plan: Plan;
  /** True when the apply was a dry-run that persisted nothing (AC6). */
  readonly dryRun: boolean;
  /** True when state was mutated (false for a no-op plan or a dry-run). */
  readonly applied: boolean;
}

/** Options for an {@link Reconciler.apply} call. */
export interface ApplyOptions {
  /** Compute and return the plan without persisting any state (AC6). */
  readonly dryRun?: boolean;
  /**
   * Converge actual state without rewriting the recorded last-applied desired
   * (issue 0024 AC7). The control loop's drift correction plans around
   * resources it must not touch by carrying their *live* content as desired;
   * recording that set as last-applied would adopt an unmanaged extra as
   * managed (and drifted alert-only content as intent), silently ending drift
   * detection for it. Intent never changes during a correction, so the
   * correction apply preserves it.
   */
  readonly preserveLastApplied?: boolean;
}

/**
 * The reconciliation engine. {@link Reconciler.plan} diffs a desired-state set
 * against the provider's actual state; {@link Reconciler.detectDrift} compares
 * actual against last-applied; {@link Reconciler.apply} executes a plan through
 * the provider; {@link Reconciler.render} formats a plan Atlas-style for review.
 *
 * The gated-vs-auto apply *policy* (prod gate #0023, dev auto-converge #0022)
 * and the continuous control loop (#0024) are downstream of this engine: `apply`
 * here simply executes a plan with no gating.
 */
export interface Reconciler {
  /** Diff `desired` against the provider's current actual state (AC1, AC3). */
  plan(desired: readonly Resource[]): Promise<Plan>;
  /** Compare actual against the last-applied desired state (AC4). */
  detectDrift(): Promise<DriftReport>;
  /** Execute (or, with `dryRun`, preview) a plan through the provider (AC7). */
  apply(plan: Plan, options?: ApplyOptions): Promise<ApplyResult>;
  /** Render a plan as a human-readable, Atlas-style report (AC2). */
  render(plan: Plan): string;
}
