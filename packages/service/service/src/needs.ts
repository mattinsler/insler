/**
 * Logical dependency declarations (`needs`) — the typed contract.
 *
 * A service author declares _what_ logical data stores / resources they need
 * (e.g. `'orders-db'`, `'valkey'`), never _how_ those are connected. The
 * declaration is purely logical: a {@link ServiceNeed} carries the logical name
 * and nothing physical — no secret ARN, connection string, or provider id. The
 * platform resolves these logical needs to physical resources elsewhere:
 *
 * - secret-binding generation (`#0015`) maps each need to a secret path by
 *   naming convention,
 * - data-store-claim generation (`#0017`) optionally provisions an unbound need,
 * - the service graph (`#0010`) surfaces needs across the fleet.
 *
 * This module owns only the logical model those downstream consumers build on:
 * the typed reference and the duplicate-rejection rule.
 */

/**
 * A typed reference to a single logical need. It carries the logical `name`
 * the author declared and nothing physical — the lifecycle/resolution
 * difference is hidden from the service author (US-3).
 */
export interface ServiceNeed {
  /** The logical need name as declared (e.g. `'orders-db'`, `'valkey'`). */
  readonly name: string;
}

/**
 * Project a raw `needs` declaration (`string[]`) into the typed reference list
 * exposed on a {@link import('./define-service.js').ServiceDef}. Returns a
 * deeply-frozen, empty-when-absent list.
 */
export function toServiceNeeds(needs: readonly string[] | undefined): readonly ServiceNeed[] {
  if (needs === undefined) {
    return Object.freeze([]);
  }
  return Object.freeze(needs.map((name) => Object.freeze({ name })));
}

/**
 * Validate a `needs` declaration. Returns an array of human-readable issues, or
 * an empty array if valid (mirroring `validateServiceKind` / `validateHandlers`).
 *
 * Rule enforced:
 * - duplicate needs within a single service are rejected; each distinct
 *   duplicated name is reported once.
 */
export function validateNeeds(needs: readonly string[] | undefined): string[] {
  const issues: string[] = [];
  if (needs === undefined) {
    return issues;
  }

  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const name of needs) {
    if (seen.has(name) && !reported.has(name)) {
      issues.push(`duplicate need: '${name}' is declared more than once`);
      reported.add(name);
    }
    seen.add(name);
  }

  return issues;
}
