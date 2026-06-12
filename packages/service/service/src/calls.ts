import type { ContractDef } from '@insler/rpc/contract';

/**
 * Cross-service contract declarations (`calls`) — the typed contract.
 *
 * A service author declares _which_ cross-service contracts they invoke: a
 * stable NATS subject plus the versioned message schema behind it, never a
 * deployment configuration. The declaration couples services only through the
 * runtime contract (subject + versioned schema), so changing a producer's
 * deployment (replica count, target, secret bindings) never forces edits to its
 * consumers (US-22, US-37). At runtime NATS handles discovery and routing — the
 * subject is `{producer-service}.{method}`, mirroring the RPC subject the
 * transport derives from `contract.kind` + method name.
 *
 * This module owns only the logical model downstream consumers build on:
 * the typed reference and the duplicate-rejection / well-formedness rules. The
 * cross-referencing of `calls` against known service subjects to build the
 * dependency graph is owned by the service graph (`#0010`); contract-version
 * compatibility enforcement across the fleet is owned by `#0030`.
 */

/**
 * A typed contract reference: the producer's `contract` plus the `method` name
 * being invoked. Resolves to the subject `{contract.kind}.{method}` — the same
 * subject the transport derives for that method. Accepting this form (rather
 * than only a raw string) gives `calls` compile-time checking: the `method`
 * must be a real method on the referenced {@link ContractDef}, so a typo or a
 * method that no longer exists on the producer is a compile error in the
 * consumer.
 */
export interface ContractCallRef<C extends ContractDef = ContractDef> {
  /** The producer's contract (its `kind` is the service identity / subject root). */
  readonly contract: C;
  /** The method name on that contract being called — constrained to its methods. */
  readonly method: keyof C['methods'] & string;
}

/**
 * What a `calls` entry may be: a raw subject string (e.g. `'orders.create'`) or
 * a typed {@link ContractCallRef} for compile-time checking.
 */
export type CallInput = string | ContractCallRef;

/**
 * A typed reference to a single cross-service call. It carries the logical
 * `subject` the author declared (or the subject resolved from a contract
 * reference) and nothing physical — no replica count, deployment target, or
 * secret binding. The producer's deployment is opaque to the consumer (US-22).
 */
export interface ServiceCall {
  /** The contract subject this service calls (e.g. `'orders.create'`). */
  readonly subject: string;
}

/** Resolve a single `calls` entry to its subject string. */
function resolveSubject(call: CallInput): string {
  if (typeof call === 'string') {
    return call;
  }
  return `${call.contract.kind}.${call.method}`;
}

/**
 * Project a raw `calls` declaration into the typed reference list exposed on a
 * {@link import('./define-service.js').ServiceDef} as `callRefs`. Returns a
 * deeply-frozen, empty-when-absent list. Each entry is resolved to its subject
 * (contract references via `{kind}.{method}`).
 */
export function toServiceCalls(calls: readonly CallInput[] | undefined): readonly ServiceCall[] {
  if (calls === undefined) {
    return Object.freeze([]);
  }
  return Object.freeze(calls.map((call) => Object.freeze({ subject: resolveSubject(call) })));
}

/**
 * Resolve a raw `calls` declaration to its plain subject strings — the
 * JSON-serializable view the generator consumes (a contract reference carries
 * live zod schemas, so it must be reduced to its subject). Empty when absent.
 */
export function toCallSubjects(calls: readonly CallInput[] | undefined): readonly string[] {
  if (calls === undefined) {
    return Object.freeze([]);
  }
  return Object.freeze(calls.map(resolveSubject));
}

/**
 * Validate a `calls` declaration. Returns an array of human-readable issues, or
 * an empty array if valid (mirroring `validateNeeds` / `validateServiceKind`).
 *
 * Rules enforced:
 * - each call must resolve to a non-empty subject;
 * - duplicate calls within a single service are rejected (compared by resolved
 *   subject); each distinct duplicated subject is reported once.
 */
export function validateCalls(calls: readonly CallInput[] | undefined): string[] {
  const issues: string[] = [];
  if (calls === undefined) {
    return issues;
  }

  const seen = new Set<string>();
  const reportedDup = new Set<string>();
  for (const call of calls) {
    const subject = resolveSubject(call);
    if (subject.trim() === '') {
      issues.push(`malformed call: a call subject must be a non-empty string`);
      continue;
    }
    if (seen.has(subject) && !reportedDup.has(subject)) {
      issues.push(`duplicate call: '${subject}' is declared more than once`);
      reportedDup.add(subject);
    }
    seen.add(subject);
  }

  return issues;
}
