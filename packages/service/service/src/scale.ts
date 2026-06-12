/**
 * Scale configuration model (#0008) — the typed contract, kind-derived
 * defaults, and cross-field validation.
 *
 * Every service scales on some signal between a replica floor and ceiling. The
 * kind taxonomy (#0002, `kind.ts`) already fixes each kind's *default* signal
 * and replica floor (its {@link import('./kind.js').OperationalProfile}); this
 * module builds the richer author-facing model on top of it:
 *
 * - the {@link ScaleConfig} a service author writes (the full `on` enum,
 *   including `rps`/`custom`, plus `min`/`max`);
 * - {@link resolveScale}, which derives the **effective** scale by falling back
 *   to the kind's default signal and floor whenever the author omits a field;
 * - {@link validateScale}, which enforces the cross-field rules (a `persistent`
 *   or `workflow` service may never declare `min: 0`; an `ephemeral` one may,
 *   and defaults to it).
 *
 * This layer owns ONLY the declaration model and its rules. Turning a resolved
 * scale into a KEDA `ScaledObject` or a Kubernetes HPA is owned by the
 * autoscaler generator (#0013) and is deliberately out of scope here — the
 * generator consumes {@link ResolvedScaleConfig}; this module produces it.
 */

import { type ServiceKind, serviceKindProfiles } from './kind.js';

/**
 * The metric a service scales on. Extends the taxonomy's per-kind
 * {@link import('./kind.js').ScalingSignal} (`queue-depth`/`cpu`/
 * `task-queue-backlog`) with the HTTP-edge / escape-hatch signals an author may
 * additionally select: `rps` (requests per second) and `custom` (an
 * operator-supplied metric the generator wires up).
 */
export type ScaleSignal = 'queue-depth' | 'cpu' | 'task-queue-backlog' | 'rps' | 'custom';

/**
 * The scaling configuration a service author optionally declares in
 * {@link import('./define-service.js').defineService}. Every field is optional
 * except the signal itself; omitted bounds fall back to the kind's defaults
 * (see {@link resolveScale}).
 */
export interface ScaleConfig {
  /** The metric to scale on. */
  readonly on: ScaleSignal;
  /**
   * Minimum replica floor. `0` is true scale-to-zero and is only valid for
   * `ephemeral`; `persistent` and `workflow` require `>= 1`.
   */
  readonly min?: number;
  /** Maximum replica ceiling. Must be `>= min` when both are set. */
  readonly max?: number;
}

/**
 * A fully-resolved scale: the effective configuration after kind defaults are
 * applied. `on` and `min` are always present (derived from the kind when the
 * author omits them); `max` is present only when declared. This is the shape
 * the autoscaler generator (#0013) consumes.
 */
export interface ResolvedScaleConfig {
  /** The effective metric to scale on. */
  readonly on: ScaleSignal;
  /** The effective replica floor. */
  readonly min: number;
  /** The replica ceiling, when declared. */
  readonly max?: number;
}

/**
 * Resolve the **effective** scale for a service from its declared `scale` (if
 * any) and its `kind`. Pure and deterministic. When `scale` is omitted, the
 * result is the kind's default profile: `ephemeral` → `queue-depth`/min 0,
 * `persistent` → `cpu`/min 1, `workflow` → `task-queue-backlog`/min 1. An
 * explicit `on` or `min` overrides the corresponding default; an explicit `max`
 * is carried through. Validation is a separate concern ({@link validateScale}) —
 * `resolveScale` only computes the effective shape.
 */
export function resolveScale(
  kind: ServiceKind,
  scale: ScaleConfig | undefined
): ResolvedScaleConfig {
  // `serviceKindProfiles[kind]` is defined for every real ServiceKind; the
  // fallback only guards a kind that slipped past type-checking, so we never
  // throw while resolving (validation is the only place we surface errors).
  const profile = serviceKindProfiles[kind] ?? serviceKindProfiles.persistent;
  const on: ScaleSignal = scale?.on ?? profile.scalingSignal;
  const min = scale?.min ?? profile.minReplicas;
  const resolved = scale?.max !== undefined ? { on, min, max: scale.max } : { on, min };
  return Object.freeze(resolved);
}

/**
 * Validate a declared `scale` against the per-kind replica-floor rules. Returns
 * an array of human-readable issues, or an empty array if valid (mirroring
 * `validateNeeds` / `validateCalls` / `validateServiceKind`).
 *
 * Rules enforced:
 * - `persistent` and `workflow` reject `min: 0` (they require a floor `>= 1`);
 * - `ephemeral` allows `min: 0` (true scale-to-zero) and any `min > 0` (warm
 *   pool);
 * - a negative `min` is rejected for every kind;
 * - `min` and `max` must be integers — fractional replica counts would flow
 *   into KEDA/HPA YAML as invalid values;
 * - `max` must be `>= min` when both are set.
 *
 * An omitted `scale` is always valid — the kind defaults apply.
 */
export function validateScale(kind: ServiceKind, scale: ScaleConfig | undefined): string[] {
  const issues: string[] = [];
  if (scale === undefined) {
    return issues;
  }

  const { min, max } = scale;

  if (min !== undefined) {
    if (!Number.isInteger(min)) {
      issues.push(`scale.min must be an integer replica count, got ${min}`);
    } else if (min < 0) {
      issues.push(`scale.min must be >= 0, got ${min}`);
    } else if ((kind === 'persistent' || kind === 'workflow') && min < 1) {
      issues.push(`${kind} services require a minimum replica floor >= 1, got scale.min=${min}`);
    }
  }

  if (max !== undefined) {
    if (!Number.isInteger(max)) {
      issues.push(`scale.max must be an integer replica count, got ${max}`);
    } else if (max < 0) {
      issues.push(`scale.max must be >= 0, got ${max}`);
    } else if (min !== undefined && max < min) {
      issues.push(`scale.max (${max}) must be >= scale.min (${min})`);
    }
  }

  return issues;
}
