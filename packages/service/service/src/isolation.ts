/**
 * Isolation tier model (#0009) — the typed contract + its default resolution.
 *
 * Every service runs inside some sandbox boundary between it and the host. The
 * `isolation` tier a service author declares in
 * {@link import('./define-service.js').defineService} selects which boundary:
 *
 * - `default` — a standard container (runc). Trusted internal services.
 * - `gvisor`  — the gVisor RuntimeClass. Portable, strong-ish isolation on
 *   commodity VMs.
 * - `microvm` — a Firecracker / Cloud Hypervisor micro-VM. The hardest boundary;
 *   requires KVM-capable hosts.
 *
 * This module owns ONLY the declaration model and its default: the
 * {@link IsolationTier} enum and {@link resolveIsolation}, which falls back to
 * `default` whenever the author omits the field, producing the **effective**
 * tier surfaced on the {@link import('./define-service.js').ServiceDef}.
 *
 * Mapping the resolved tier to a concrete Kubernetes RuntimeClass name, and
 * validating that the target host satisfies the tier's capability requirements
 * (a `microvm` tier needs a KVM-capable node), are owned by the Kubernetes
 * manifest generator (#0012) and are deliberately out of scope here — the
 * generator consumes the effective {@link IsolationTier}; this module produces
 * it. The PRD marks sandbox/VMM selection itself as "out of scope" to build: the
 * runtime host is rented/adopted, and this layer is about the *declaration*, not
 * the VMM.
 */

/**
 * The sandbox / RuntimeClass tier a workload runs under. `default` is a standard
 * container (runc); `gvisor` is the gVisor RuntimeClass; `microvm` is a
 * Firecracker / Cloud Hypervisor micro-VM (requires KVM-capable hosts).
 */
export type IsolationTier = 'default' | 'gvisor' | 'microvm';

/** The tier applied when a service declares no `isolation`. */
const DEFAULT_ISOLATION_TIER: IsolationTier = 'default';

/**
 * Resolve the **effective** isolation tier for a service from its declared
 * `isolation` (if any). Pure and deterministic: an omitted tier falls back to
 * `default` (a standard container); an explicit tier is carried through
 * unchanged. This is the value the Kubernetes manifest generator (#0012)
 * consumes to select a RuntimeClass and check host capabilities.
 */
export function resolveIsolation(isolation: IsolationTier | undefined): IsolationTier {
  return isolation ?? DEFAULT_ISOLATION_TIER;
}
