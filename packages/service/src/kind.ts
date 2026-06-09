/**
 * Service kind taxonomy and lifecycle semantics.
 *
 * The kind axis is the primary dimension that determines how a service is
 * deployed and operated. The decision rule is simple: **does the service hold
 * state or work _between_ requests?**
 *
 * - `ephemeral` — exists only while serving a request (request/response or a
 *   single long-lived stream). Scales to zero when idle. Holds no state between
 *   requests; any cross-request state must be externalized (Valkey/NATS-KV/
 *   Postgres) to stay ephemeral. Streaming does NOT force `persistent`: a
 *   server-stream is one long request.
 * - `persistent` — always-on with a replica floor (>= 1). For services that
 *   hold state, connections, or background work between requests.
 * - `workflow` — a durable orchestration worker (Temporal-style). First-class
 *   for ergonomics, but it **inherits `persistent`'s operational profile**: it
 *   compiles to a persistent poller with a task queue and is never scaled to
 *   zero. Requires a `taskQueue`.
 *
 * Transport (`expose`) is orthogonal to kind — an ephemeral service can still
 * be exposed over HTTP.
 */

/** The three service lifecycle kinds. */
export type ServiceKind = 'ephemeral' | 'persistent' | 'workflow';

/** The lifecycle kinds enumerated at runtime, in declaration order. */
export const SERVICE_KINDS: readonly ServiceKind[] = ['ephemeral', 'persistent', 'workflow'];

/**
 * The default scaling signal a kind scales on. The full `scale.on` enum (incl.
 * `rps`/`custom`) is owned by the scale-configuration model (#0008); this is the
 * per-kind default that the taxonomy fixes.
 */
export type ScalingSignal = 'queue-depth' | 'cpu' | 'task-queue-backlog';

/** The operational defaults a kind maps to. */
export interface OperationalProfile {
  /** Minimum replica floor. `0` only for `ephemeral`. */
  readonly minReplicas: number;
  /** Whether the kind may scale to zero when idle. */
  readonly scaleToZero: boolean;
  /** The metric the kind scales on by default. */
  readonly scalingSignal: ScalingSignal;
}

/** The default operational profile for each lifecycle kind. */
export const serviceKindProfiles: Record<ServiceKind, OperationalProfile> = {
  ephemeral: { minReplicas: 0, scaleToZero: true, scalingSignal: 'queue-depth' },
  persistent: { minReplicas: 1, scaleToZero: false, scalingSignal: 'cpu' },
  // workflow inherits persistent's operational profile (min >= 1, never zero),
  // scaling on task-queue backlog.
  workflow: { minReplicas: 1, scaleToZero: false, scalingSignal: 'task-queue-backlog' },
};

/** The minimal scale shape the taxonomy validates. The full `ScaleConfig` (with
 * `on`/`max`) is owned by #0008; here we only care about the replica floor. */
export interface KindScale {
  readonly min?: number;
}

/** Fields the kind taxonomy contributes to a service declaration. `workflow`
 * additionally requires a `taskQueue`; the other kinds must not carry one. */
export type KindDeclaration =
  | { readonly kind: 'ephemeral'; readonly taskQueue?: never; readonly scale?: KindScale }
  | { readonly kind: 'persistent'; readonly taskQueue?: never; readonly scale?: KindScale }
  | { readonly kind: 'workflow'; readonly taskQueue: string; readonly scale?: KindScale };

/**
 * Validate a declaration's kind/scale combination against the lifecycle rules.
 * Returns an array of human-readable issues, or an empty array if valid
 * (mirroring `validateHandlers`).
 *
 * Rules enforced:
 * - `persistent` and `workflow` require a replica floor >= 1 (reject `scale.min < 1`).
 * - `ephemeral` may set any `scale.min >= 0` (0 = true scale-to-zero, > 0 = warm pool).
 * - `workflow` requires a non-empty `taskQueue`.
 */
export function validateServiceKind(declaration: KindDeclaration): string[] {
  const issues: string[] = [];
  const { kind } = declaration;
  const min = declaration.scale?.min;

  if (
    kind === 'workflow' &&
    (typeof declaration.taskQueue !== 'string' || declaration.taskQueue.length === 0)
  ) {
    issues.push("workflow services require a non-empty 'taskQueue'");
  }

  if ((kind === 'persistent' || kind === 'workflow') && min !== undefined && min < 1) {
    issues.push(`${kind} services require a minimum replica floor >= 1, got scale.min=${min}`);
  }

  return issues;
}
