import { scanFleet } from '@insler/platform/fleet';
import { applyGated, createReconciler } from '@insler/platform/reconciler';
import type { Reconciler } from '@insler/platform/reconciler';

import type { StateProviderFactory } from './plan.js';
import {
  createFileAuditSink,
  createFileStateProvider,
  deriveDesiredState,
  PRODUCTION_ENV,
  resolveOperator,
} from './reconcile-shared.js';
import type { ReconcileIO } from './reconcile-shared.js';

/**
 * The `insler apply` command (issue 0023). Scans a directory into a fleet
 * manifest, derives the desired-state artifacts, plans the diff against the
 * actual state in the `--state` snapshot, prints the plan, then executes it.
 *
 * `--env production` routes through the **production gate** (AC2/AC4/AC6/AC7):
 * the plan is applied only if it still matches live actual state (no blind/stale
 * apply), and every attempt — applied or rejected — is written to the audit
 * trail with the resolved operator identity, a timestamp, and the diff. Other
 * environments keep the ungated, fast apply. `--dry-run` (non-production) prints
 * the plan and persists nothing. On an invalid fleet it prints each error and
 * applies nothing (exit 1); a rejected production plan also exits 1.
 *
 * The dev auto-converge *policy* (#0022) and the control loop (#0024) remain
 * downstream. Kept I/O-injectable (streams, scan, provider factory) so it is
 * unit-testable without a process or a real backend.
 */

/** Where the command writes its output and diagnostics. */
export type ApplyIO = ReconcileIO;

/** Parsed `insler apply` arguments. */
export interface ApplyArgs {
  /** Directory to scan for service declarations (defaults to cwd). */
  readonly cwd?: string;
  /** Environment name passed to the generator (defaults to `dev`). */
  readonly environment?: string;
  /** Path to the actual-state JSON snapshot (empty actual when omitted). */
  readonly statePath?: string;
  /** Compute and print the plan without executing it or persisting state. */
  readonly dryRun?: boolean;
  /** Path to the append-only JSONL audit trail (production gate, AC4/AC6). */
  readonly auditPath?: string;
  /** Operator identity recorded in the audit trail (AC4). */
  readonly operator?: string;
}

/** Default audit-trail location when `--audit` is omitted in production. */
const DEFAULT_AUDIT_PATH = 'insler-audit.jsonl';

/**
 * Run the apply command. Returns the process exit code: `0` on a valid fleet
 * applied (or a clean dry-run/no-op), `1` when the scan failed or a production
 * plan was rejected (e.g. stale). The `scanFleet` dependency and the
 * state-provider factory are injectable so tests can drive them with stubs.
 */
export async function runApply(
  args: ApplyArgs,
  io: ApplyIO,
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
    // e.g. a corrupt --state snapshot: report and apply nothing — never
    // overwrite a snapshot we could not read.
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
  io.out(reconciler.render(plan));

  if (args.environment === PRODUCTION_ENV) {
    return applyProduction(reconciler, plan, args, io);
  }

  // Non-production: the ungated, fast-converge apply (the dev policy proper,
  // #0022, layers on later). `--dry-run` previews without persisting.
  const result = await reconciler.apply(plan, { dryRun: args.dryRun === true });
  if (result.dryRun) {
    io.out('Dry run: no changes applied.');
  } else if (result.applied) {
    const { add, change, destroy } = plan.summary;
    io.out(`Applied: ${add} added, ${change} changed, ${destroy} destroyed.`);
  } else {
    io.out('Nothing to apply.');
  }
  return 0;
}

/**
 * The production branch: gate the apply behind a plan-match check and write the
 * outcome to the audit trail. A rejected plan (e.g. stale) is reported on stderr
 * and exits 1 — never a silent or partial apply.
 */
async function applyProduction(
  reconciler: Reconciler,
  plan: Awaited<ReturnType<Reconciler['plan']>>,
  args: ApplyArgs,
  io: ApplyIO
): Promise<number> {
  const audit = createFileAuditSink(args.auditPath ?? DEFAULT_AUDIT_PATH);
  const operator = resolveOperator(args.operator);
  const gated = await applyGated(reconciler, plan, { operator, audit });

  if (gated.outcome === 'rejected') {
    io.err(`Apply rejected: ${gated.reason ?? 'plan could not be applied'}`);
    io.out(`Rejected plan logged to the audit trail (operator: ${operator}).`);
    return 1;
  }

  if (gated.apply?.applied === true) {
    const { add, change, destroy } = plan.summary;
    io.out(`Applied: ${add} added, ${change} changed, ${destroy} destroyed.`);
  } else {
    io.out('Nothing to apply.');
  }
  io.out(`Audit record written (operator: ${operator}).`);
  return 0;
}
