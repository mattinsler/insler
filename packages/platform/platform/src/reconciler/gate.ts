import { blastRadius } from './blast-radius.js';
import type {
  AuditRecord,
  GatedApplyOptions,
  GatedApplyResult,
  Plan,
  Reconciler,
} from './types.js';

/**
 * The production apply gate (issue 0023). Wraps the engine's *ungated*
 * {@link Reconciler.apply} with the production policy:
 *
 * - **No blind / no stale apply (AC2, AC7):** apply only proceeds if the plan
 *   still matches the live actual state. The engine re-checks the plan's
 *   fingerprint against the provider's current actual and throws on a mismatch
 *   (reusing issue 0028's stale-plan guard); the gate catches that and records a
 *   rejection rather than letting it escape unaudited.
 * - **Audit trail (AC4, AC6):** every attempt — applied or rejected — writes one
 *   {@link AuditRecord} (operator, timestamp, the diff, its blast radius) to the
 *   {@link AuditSink}, so a production change is always traceable for SOC 2.
 *
 * This is the policy layer the engine intentionally omits: dev auto-converge
 * (#0022) and the continuous control loop (#0024) are separate downstream
 * policies over the same engine.
 */
export async function applyGated(
  reconciler: Reconciler,
  plan: Plan,
  options: GatedApplyOptions
): Promise<GatedApplyResult> {
  const now = options.now ?? ((): Date => new Date());
  const timestamp = now().toISOString();
  const radius = blastRadius(plan);

  try {
    const apply = await reconciler.apply(plan);
    const record: AuditRecord = {
      outcome: 'applied',
      operator: options.operator,
      timestamp,
      plan,
      blastRadius: radius,
    };
    await options.audit.record(record);
    return { outcome: 'applied', audit: record, apply };
  } catch (error) {
    // A failed apply (today: only a stale-plan rejection from the engine) must
    // still be audited — a refused production change is as load-bearing for the
    // trail as an accepted one (AC6).
    const reason = error instanceof Error ? error.message : String(error);
    const record: AuditRecord = {
      outcome: 'rejected',
      operator: options.operator,
      timestamp,
      plan,
      blastRadius: radius,
      reason,
    };
    await options.audit.record(record);
    return { outcome: 'rejected', audit: record, reason };
  }
}
