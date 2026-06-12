import { scanFleet } from '@insler/platform/fleet';
import { createReconciler, renderPlanComment } from '@insler/platform/reconciler';
import type { StateProvider } from '@insler/platform/reconciler';

import { createFileStateProvider, deriveDesiredState } from './reconcile-shared.js';
import type { ReconcileIO } from './reconcile-shared.js';

/**
 * The `insler plan` command (issue 0023 AC1/AC5). Scans a directory into a fleet
 * manifest, derives the desired-state artifacts via the generator, diffs them
 * against the actual state read from the `--state` snapshot, and prints the
 * Atlas-style plan. With `--comment` it instead prints a Markdown block suitable
 * for a CI pull-request comment (heading + blast radius + fenced diff, AC5). It
 * is read-only — it never mutates state. On an invalid fleet it prints each error
 * with its file location(s) and plans nothing (exit 1).
 *
 * Kept I/O-injectable (streams, the scan function, and the state-provider
 * factory) so it is unit-testable without a process or a real backend.
 */

/** Where the command writes its output and diagnostics. */
export type PlanIO = ReconcileIO;

/** Parsed `insler plan` arguments. */
export interface PlanArgs {
  /** Directory to scan for service declarations (defaults to cwd). */
  readonly cwd?: string;
  /** Environment name passed to the generator (defaults to `dev`). */
  readonly environment?: string;
  /** Path to the actual-state JSON snapshot (empty actual when omitted). */
  readonly statePath?: string;
  /** Emit a Markdown CI PR comment instead of the plain plan (AC5). */
  readonly comment?: boolean;
}

/** Builds the {@link StateProvider} a plan reconciles against (injectable for tests). */
export type StateProviderFactory = (statePath: string | undefined) => StateProvider;

/**
 * Run the plan command. Returns the process exit code: `0` on a valid fleet,
 * `1` when any cross-service constraint failed. The `scanFleet` dependency and
 * the state-provider factory are injectable so tests can drive them with stubs.
 */
export async function runPlan(
  args: PlanArgs,
  io: PlanIO,
  scan: typeof scanFleet = scanFleet,
  makeProvider: StateProviderFactory = createFileStateProvider
): Promise<number> {
  const derived = await deriveDesiredState(args.cwd, args.environment, io, scan);
  if (derived.desired === undefined) {
    return derived.code;
  }

  const reconciler = createReconciler(makeProvider(args.statePath));
  let plan: Awaited<ReturnType<typeof reconciler.plan>>;
  try {
    plan = await reconciler.plan(derived.desired);
  } catch (error) {
    // e.g. a corrupt --state snapshot: report and plan nothing.
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
  io.out(args.comment === true ? renderPlanComment(plan) : reconciler.render(plan));
  return 0;
}
