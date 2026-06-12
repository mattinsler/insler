/**
 * Service identity model (#0004) — the typed contract + its derivation.
 *
 * Every service has a unique, stable identity derived from the `name` it
 * declares in {@link import('./define-service.js').defineService} and the
 * deployment environment it runs in. Identity is the anchor for every security
 * and operational concern downstream:
 *
 * - NATS credential scoping (publish/subscribe permissions per subject) — #0016,
 * - secret resolution by naming convention — #0015,
 * - Kubernetes ServiceAccount / workload-identity binding (IRSA / GCP WI /
 *   SPIFFE) — #0012,
 * - OTel span / metric / log attribution — #0026.
 *
 * This module owns ONLY the model those consumers build on: the
 * {@link ServiceIdentity} type and the deterministic {@link deriveIdentity}
 * derivation. The cross-fleet uniqueness rule (no two scanned declarations may
 * derive the same identity) lives in `@insler/platform/fleet`'s manifest builder, which
 * already performs cross-service validation. The named consumers above are out
 * of scope here — this layer only defines what they consume.
 *
 * The identity is:
 * - **Deterministic** — the same declaration and environment always derive the
 *   same identity (`deriveIdentity` is a pure function of its inputs).
 * - **Stable** — identity flows from the declared `name`; renaming a service is
 *   therefore an explicit, trackable change (a new identity).
 * - **Hierarchical** — `environment.namespace.name` (e.g. `prod.orders.summarize`),
 *   so it scopes naturally for NATS subjects, secret paths, and SA names.
 */

import type { ServiceDef } from './define-service.js';
import type { ServiceEnv } from './env.js';

/** The namespace used when a service `name` carries no namespace segment. */
const DEFAULT_NAMESPACE = 'default';

/**
 * The stable short token each {@link ServiceEnv} contributes to a qualified
 * identity. Short, DNS/subject-friendly, and frozen so it never drifts — these
 * tokens appear in NATS subjects, secret paths, and ServiceAccount names.
 */
const ENVIRONMENT_TOKENS: Readonly<Record<ServiceEnv, string>> = Object.freeze({
  production: 'prod',
  development: 'dev',
  test: 'test',
});

/**
 * A service's unique, stable identity. Derived from the declared `name` and the
 * deployment environment; the anchor every security/observability concern keys
 * off of.
 */
export interface ServiceIdentity {
  /** The service's own name — the final segment of the declared `name`. */
  readonly name: string;
  /**
   * The namespace the service lives in — the leading segment(s) of the declared
   * `name`, or {@link DEFAULT_NAMESPACE} when the name carries no namespace.
   */
  readonly namespace: string;
  /** The short environment token (`prod` / `dev` / `test`). */
  readonly environment: string;
  /**
   * The fully-qualified, hierarchical identity: `environment.namespace.name`
   * (e.g. `prod.orders.summarize`). Deterministic and unique within a
   * deployment; the value downstream consumers scope credentials, secrets, and
   * workload identity off of.
   */
  readonly qualifiedName: string;
}

/** Split a declared `name` into its namespace and own-name segments. */
function splitName(name: string): { readonly namespace: string; readonly name: string } {
  const segments = name.split('.');
  const own = segments[segments.length - 1] ?? name;
  const namespace = segments.length > 1 ? segments.slice(0, -1).join('.') : DEFAULT_NAMESPACE;
  return { namespace, name: own };
}

/**
 * Derive a service's {@link ServiceIdentity} from its declaration and the
 * environment it is deployed into.
 *
 * Pure and deterministic: identical `(def, environment)` inputs always yield an
 * equal, frozen identity. The declared `name` is the stable anchor — its final
 * dotted segment becomes the service name and any leading segments become the
 * namespace (defaulting to `default`). The environment maps to its short token
 * and prefixes the hierarchical `qualifiedName`, so the same service in two
 * environments has two distinct identities.
 */
export function deriveIdentity(def: ServiceDef, environment: ServiceEnv): ServiceIdentity {
  const { namespace, name } = splitName(def.name);
  const env = ENVIRONMENT_TOKENS[environment];
  return Object.freeze({
    name,
    namespace,
    environment: env,
    qualifiedName: `${env}.${namespace}.${name}`,
  });
}
