import type { BlastRadius, Plan, ResourceChange } from './types.js';

/**
 * Derive the service a resource belongs to from its path (issue 0023 AC3).
 * Generated resource paths are service-scoped (`deployment/<name>`,
 * `service/<name>`, …), so the *trailing* segment after the kind prefix names
 * the service; a flat, prefix-less path (`fleet-inventory.json`) is its own
 * service. Pure string logic — no I/O, no knowledge of the generator.
 */
function serviceOf(path: string): string {
  const slash = path.indexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

/**
 * Compute the {@link BlastRadius} of a {@link Plan} (issue 0023 AC3): the count
 * of consequential resource changes and the distinct, sorted set of services
 * those changes touch. No-ops are excluded — a converged plan has an empty blast
 * radius. Pure; the result is denormalized into the audit trail next to the plan.
 */
export function blastRadius(plan: Plan): BlastRadius {
  const consequential = plan.changes.filter((c: ResourceChange) => c.action !== 'no-op');
  const services = new Set(consequential.map((c) => serviceOf(c.path)));
  return {
    servicesAffected: [...services].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    resourcesChanged: consequential.length,
    summary: plan.summary,
  };
}
