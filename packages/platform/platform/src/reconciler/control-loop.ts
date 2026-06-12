import type {
  ControlLoop,
  ControlLoopOptions,
  DriftAction,
  DriftEvent,
  DriftLogEntry,
  Reconciler,
  ReconcileResult,
  Resource,
  ResourceChange,
  Ticker,
} from './types.js';

/**
 * `@insler/platform/reconciler`'s continuous control loop (issue 0024) — the "healing"
 * policy *over* the engine (#0021). It is what makes operating hundreds of
 * services sustainable for one person: drift correction is not a manual task you
 * stay awake for.
 *
 * Each pass:
 *
 * 1. Detects drift via the engine ({@link Reconciler.detectDrift}) — actual vs
 *    the last-applied desired, read through the {@link StateProvider} seam (AC2).
 * 2. Classifies every drifted resource into one of the issue's four categories
 *    (AC2) and marks it managed vs unmanaged (AC6): an `extra-resource` (present
 *    in actual, absent from last-applied) is one we do *not* own.
 * 3. Decides per category + mode whether to correct or only alert:
 *    - **development** corrects every correctable category (replica-count,
 *      config-drift, missing-resource) (AC3); an `extra-resource` is *only*
 *      alerted — correcting it would fight whatever controller created it (AC7).
 *    - **production** is conservative: it alerts on all drift and corrects
 *      nothing by default (AC4). With `autoCorrectSafeInProduction`, it also
 *      corrects the *safe* categories (replica-count, config-drift); a
 *      `missing-resource` is "alert first" and is never auto-corrected in
 *      production; an `extra-resource` is never corrected in any mode.
 * 4. Logs one {@link DriftLogEntry} per event — event + action + timestamp — to
 *    the {@link DriftLog} (AC5).
 *
 * Correcting drift **preserves unmanaged resources**: the loop never converges
 * through the raw drift plan (which would destroy extras). Instead it builds a
 * correction desired set of the managed (last-applied) resources *plus* the
 * unmanaged extras currently live, so extras survive as no-ops (AC7). The
 * correction also **never rewrites intent**: it applies with
 * `preserveLastApplied`, so an extra stays out of last-applied — still
 * classified and alerted as an `extra-resource` on every later pass — instead
 * of being silently adopted as managed.
 *
 * Boundary: this is a policy over the {@link Reconciler} and the {@link StateProvider}
 * seam — engine-only. The periodic driver is an injectable {@link Ticker}, never
 * a real timer, so the loop is hermetic and deterministic under test; the real
 * interval-backed ticker and any CLI entry live one layer up in `@insler/cli`.
 */
class ControlLoopImpl implements ControlLoop {
  readonly #reconciler: Reconciler;
  readonly #options: ControlLoopOptions;

  constructor(reconciler: Reconciler, options: ControlLoopOptions) {
    this.#reconciler = reconciler;
    this.#options = options;
  }

  async reconcileOnce(): Promise<ReconcileResult> {
    const report = await this.#reconciler.detectDrift();
    const now = this.#options.now ?? ((): Date => new Date());
    const timestamp = now().toISOString();

    if (!report.hasDrift) {
      return { events: [], corrected: [], alerted: [], applied: false, log: [] };
    }

    const events = report.plan.changes.filter((c) => c.action !== 'no-op').map((c) => classify(c));

    // Decide correct-vs-alert per event, then converge the managed corrections
    // in one apply that leaves unmanaged extras untouched.
    const corrected: DriftEvent[] = [];
    const alerted: DriftEvent[] = [];
    for (const event of events) {
      if (this.#shouldCorrect(event)) corrected.push(event);
      else alerted.push(event);
    }

    const correctedPaths = new Set(corrected.map((e) => e.path));
    const applied =
      corrected.length > 0 ? await this.#correct(report.plan.changes, correctedPaths) : false;

    const log: DriftLogEntry[] = [];
    for (const event of events) {
      const action: DriftAction = corrected.includes(event) ? 'corrected' : 'alerted';
      const entry: DriftLogEntry = { event, action, timestamp };
      this.#options.log.record(entry);
      log.push(entry);
    }

    return { events, corrected, alerted, applied, log };
  }

  async run(ticker: Ticker): Promise<readonly ReconcileResult[]> {
    const results: ReconcileResult[] = [];
    // Drive one pass per tick. The ticker is the only clock: resolving falsy
    // stops the loop, so a test ticker that fires N times runs exactly N passes
    // with no wall-clock dependency.
    while ((await ticker.next()) === true) {
      results.push(await this.reconcileOnce());
    }
    return results;
  }

  /**
   * The correct-vs-alert policy. An unmanaged `extra-resource` is never corrected
   * (AC7). Development corrects every managed category. Production corrects
   * nothing unless `autoCorrectSafeInProduction` is set, and even then only the
   * *safe* categories — a `missing-resource` is alert-first in production (AC4).
   */
  #shouldCorrect(event: DriftEvent): boolean {
    if (event.category === 'extra-resource') return false;
    if (this.#options.mode === 'development') return true;
    if (this.#options.autoCorrectSafeInProduction !== true) return false;
    return event.category === 'replica-count' || event.category === 'config-drift';
  }

  /**
   * Converge only the corrected resources back to intent while preserving every
   * resource we did *not* correct — unmanaged extras and any alert-only managed
   * drift (e.g. a missing resource in production).
   *
   * The drift plan diffs last-applied (the desired side) against actual, so each
   * change already carries both states: `before` is the live actual content,
   * `after` is the intended (last-applied) content. The correction desired set
   * is therefore built per change:
   *
   * - a corrected change/add → take `after` (snap back to / restore intent);
   * - any other surviving resource (no-op, alert-only change, missing-but-not-
   *   corrected, or an unmanaged extra/destroy) → keep `before` (its live
   *   content), so it diffs to a no-op and is left exactly as it is.
   *
   * Applying the resulting plan converges only what we chose to correct (AC7).
   *
   * The apply carries `preserveLastApplied`: a correction converges actual back
   * toward the existing intent and must never rewrite that intent. Recording the
   * correction's desired set (which deliberately carries live content for the
   * resources it must not touch) would adopt an unmanaged extra into last-applied
   * — silently ending its `extra-resource` alerts and treating it as managed on
   * later passes (AC6/AC7) — and likewise adopt alert-only drifted content as
   * intent while dropping an uncorrected missing resource from it (AC4).
   *
   * Returns whether state was mutated.
   */
  async #correct(
    changes: readonly ResourceChange[],
    correctedPaths: ReadonlySet<string>
  ): Promise<boolean> {
    const desired: Resource[] = [];
    for (const change of changes) {
      const correcting = correctedPaths.has(change.path);
      // Corrected add/change → intended content; everything else → live content.
      const content = correcting ? change.after : change.before;
      if (content === undefined) continue; // a corrected destroy never happens (extras aren't corrected)
      desired.push({ path: change.path, content, format: change.format });
    }

    const plan = await this.#reconciler.plan(desired);
    const result = await this.#reconciler.apply(plan, { preserveLastApplied: true });
    return result.applied;
  }
}

/**
 * Classify one drift {@link ResourceChange} into a {@link DriftEvent}. The diff
 * action fixes three categories directly — `add` (re-converging a deleted
 * resource) is a `missing-resource`, `destroy` (a resource not in intent) is an
 * unmanaged `extra-resource` — and a `change` is split into `replica-count` (only
 * the replica field moved) vs `config-drift` (anything else) by comparing the
 * before/after specs.
 */
function classify(change: ResourceChange): DriftEvent {
  const base = {
    path: change.path,
    action: change.action,
    before: change.before,
    after: change.after,
  };
  switch (change.action) {
    case 'add':
      return { ...base, category: 'missing-resource', managed: true };
    case 'destroy':
      return { ...base, category: 'extra-resource', managed: false };
    case 'change':
      return {
        ...base,
        category: isReplicaOnlyChange(change.before, change.after)
          ? 'replica-count'
          : 'config-drift',
        managed: true,
      };
    default:
      // `no-op` changes are filtered out before classification.
      return { ...base, category: 'config-drift', managed: true };
  }
}

/**
 * True when the only difference between two resource specs is the `replicas`
 * field — a manual scale (AC2 "replica count" category). Specs are JSON; if
 * either side does not parse as an object, the change is treated as config drift
 * (the conservative classification). Pure.
 */
function isReplicaOnlyChange(before: string | undefined, after: string | undefined): boolean {
  if (before === undefined || after === undefined) return false;
  const a = parseSpec(before);
  const b = parseSpec(after);
  if (a === undefined || b === undefined) return false;

  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (key === 'replicas') continue;
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false;
  }
  // Something must actually differ, and it can only be `replicas`.
  return JSON.stringify(a['replicas']) !== JSON.stringify(b['replicas']);
}

function parseSpec(content: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(content);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Create the continuous control loop over an engine ({@link Reconciler}) and a
 * {@link ControlLoopOptions} policy. The loop is the downstream "healing" policy
 * for issue 0024; the engine and its {@link StateProvider} seam do all the
 * actual-state I/O.
 */
export function createControlLoop(
  reconciler: Reconciler,
  options: ControlLoopOptions
): ControlLoop {
  return new ControlLoopImpl(reconciler, options);
}
