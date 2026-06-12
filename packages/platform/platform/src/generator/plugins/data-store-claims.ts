import type { FleetManifest } from '../../fleet/index.js';
import type { GeneratedFile, GeneratorOptions, GeneratorPlugin } from '../types.js';

/**
 * Data-store claim generation (#0017) — the "provision new" half of how a
 * service's logical {@link FleetManifest} `needs` are fulfilled. The complement
 * is the "bind existing" half owned by secret-binding generation (#0015), which
 * this plugin only *references* (it never builds binding logic).
 *
 * A service author declares a logical need (`needs: ['orders-db']`); they never
 * say whether it is an already-running managed instance or something to stand
 * up. That lifecycle decision is a platform concern resolved here:
 *
 * - A need the operator has **registered** (an existing managed instance) is
 *   bound, never provisioned (AC6) — registration is the lever that prevents
 *   auto-provisioning of stores that should be managed externally (AC5).
 * - An **unbound** need (no registered instance) is, under the default policy,
 *   *not* provisioned: it surfaces as a plan error. The PRD is explicit —
 *   "stateful stores remain managed services where available" — so the default
 *   is to bind, and auto-provisioning is an explicit opt-in (`provision: 'auto'`)
 *   for development environments. In production an unbound need is a planning
 *   failure, never a silent `CREATE`.
 *
 * When auto-provisioning is enabled, each unbound need becomes a declarative,
 * Crossplane-compatible resource claim (AC2) carrying per-data-store-type
 * default parameters (AC3) and a `writeConnectionSecretToRef` whose secret name
 * is the logical need — the naming convention #0015 binds on (AC4).
 *
 * Boundary: reads only the `needs` projection of the manifest *model*; performs
 * no I/O; deterministic (claims sorted by logical name → path-sorted output).
 */

/** The provisioning policy for unbound needs. */
export type ProvisionPolicy =
  /**
   * Default. Never emit a provisioning claim; an unbound need surfaces as a plan
   * error so externally-managed stores are never auto-created (AC5, Notes).
   */
  | 'bind'
  /**
   * Opt-in (development / operator-approved): emit a provisioning claim for each
   * unbound need that has a resolvable data-store type.
   */
  | 'auto';

/**
 * The per-data-store-type defaults an operator configures (AC3): the Crossplane
 * resource identity (`apiVersion` / `kind`), the composition to satisfy the
 * claim with, and the default `spec.parameters` for that store type.
 */
export interface DataStoreTypeDefaults {
  /** Crossplane claim `apiVersion` (e.g. `database.crossplane.io/v1alpha1`). */
  readonly apiVersion: string;
  /** Crossplane claim `kind` (e.g. `PostgreSQLInstance`). */
  readonly kind: string;
  /** The `spec.compositionRef.name` the claim is satisfied by. */
  readonly compositionRef: string;
  /** Default `spec.parameters` for this store type; rendered verbatim. */
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
}

/** Configuration for {@link dataStoreClaimsPlugin}. Every field is optional. */
export interface DataStoreClaimsConfig {
  /**
   * Logical needs the operator has registered as existing managed instances.
   * A registered need is bound, never provisioned (AC6) — the lever that keeps
   * externally-managed stores from being auto-created (AC5).
   */
  readonly registered?: readonly string[];
  /** Policy for unbound needs. Defaults to `'bind'` (never auto-provision). */
  readonly provision?: ProvisionPolicy;
  /**
   * Per-data-store-type defaults (AC3), keyed by logical need name. An entry
   * here both *enables* provisioning that need (a type is resolvable) and
   * supplies its claim identity + default parameters. Merged over the built-in
   * defaults; an unmatched need with no built-in default cannot be provisioned.
   */
  readonly dataStoreTypes?: Readonly<Record<string, DataStoreTypeDefaults>>;
  /** Namespace for the generated connection-secret ref. Defaults to `services`. */
  readonly secretNamespace?: string;
}

/**
 * Built-in defaults: a logical need whose name ends in `-db` resolves to a
 * Crossplane PostgreSQL claim. This is the only built-in type — every other
 * store type must be configured explicitly (AC3), so the plugin never *guesses*
 * a provisioning shape for a store it does not know how to stand up.
 */
const POSTGRES_DEFAULTS: DataStoreTypeDefaults = {
  apiVersion: 'database.crossplane.io/v1alpha1',
  kind: 'PostgreSQLInstance',
  compositionRef: 'production-postgres',
  parameters: { storageGB: 20, version: '16' },
};

const CLAIMS_DIR = 'data-store-claims';

/** Collect the distinct logical needs across the fleet, sorted (determinism). */
function distinctNeeds(manifest: FleetManifest): readonly string[] {
  const names = new Set<string>();
  for (const edge of manifest.graph.edges) {
    if (edge.type === 'needs') {
      names.add(edge.to);
    }
  }
  return [...names].sort();
}

/** Resolve a need to its data-store-type defaults, or `undefined` if unknown. */
function resolveType(
  need: string,
  configured: Readonly<Record<string, DataStoreTypeDefaults>>
): DataStoreTypeDefaults | undefined {
  const override = configured[need];
  if (override !== undefined) {
    return override;
  }
  if (need.endsWith('-db')) {
    return POSTGRES_DEFAULTS;
  }
  return undefined;
}

/** Render a scalar as YAML, quoting strings so e.g. a numeric-looking version stays a string. */
function renderScalar(value: string | number | boolean): string {
  return typeof value === 'string' ? `"${value}"` : String(value);
}

/** Render one Crossplane claim as deterministic YAML text. */
function renderClaim(need: string, type: DataStoreTypeDefaults, secretNamespace: string): string {
  const paramLines = Object.keys(type.parameters)
    .sort()
    .map((key) => `    ${key}: ${renderScalar(type.parameters[key] as string | number | boolean)}`);

  return [
    `apiVersion: ${type.apiVersion}`,
    `kind: ${type.kind}`,
    'metadata:',
    `  name: ${need}`,
    'spec:',
    '  parameters:',
    ...paramLines,
    '  compositionRef:',
    `    name: ${type.compositionRef}`,
    '  writeConnectionSecretToRef:',
    `    name: ${need}`,
    `    namespace: ${secretNamespace}`,
    '',
  ].join('\n');
}

/** Render the plan-errors artifact listing needs that could not be bound/provisioned. */
function renderPlanErrors(errors: readonly string[]): string {
  return [
    '# Data-store plan errors (#0017).',
    '# These logical needs are unbound: no registered instance and not auto-provisioned.',
    '# Register an existing managed instance or enable provisioning for the store type.',
    'unboundNeeds:',
    ...errors.map((need) => `  - ${need}`),
    '',
  ].join('\n');
}

/**
 * Build the data-store-claims generator plugin (#0017). See module docs for the
 * bind-vs-provision policy.
 */
export function dataStoreClaimsPlugin(config: DataStoreClaimsConfig = {}): GeneratorPlugin {
  const registered = new Set(config.registered ?? []);
  const policy: ProvisionPolicy = config.provision ?? 'bind';
  const configuredTypes = config.dataStoreTypes ?? {};
  const secretNamespace = config.secretNamespace ?? 'services';

  return {
    name: 'data-store-claims',
    generate(manifest: FleetManifest, _options: GeneratorOptions): readonly GeneratedFile[] {
      // AC1/AC6: an unbound need is one with no registered existing instance.
      const unbound = distinctNeeds(manifest).filter((need) => !registered.has(need));

      const files: GeneratedFile[] = [];
      const planErrors: string[] = [];

      for (const need of unbound) {
        const type = resolveType(need, configuredTypes);

        // AC5/Notes: default is to bind, never auto-provision. An unbound need —
        // or, even under auto, one whose store type cannot be resolved — is a
        // plan error, never a guessed `CREATE`.
        if (policy === 'bind' || type === undefined) {
          planErrors.push(need);
          continue;
        }

        // AC2/AC3/AC4: emit a Crossplane claim with per-type defaults and a
        // connection-secret ref keyed on the logical need (the #0015 convention).
        files.push({
          path: `${CLAIMS_DIR}/${need}.yaml`,
          content: renderClaim(need, type, secretNamespace),
          format: 'yaml',
        });
      }

      if (planErrors.length > 0) {
        files.push({
          path: `${CLAIMS_DIR}/plan-errors.yaml`,
          content: renderPlanErrors([...planErrors].sort()),
          format: 'yaml',
        });
      }

      // Deterministic, path-sorted output (Notes).
      return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    },
  };
}
