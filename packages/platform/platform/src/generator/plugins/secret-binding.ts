import type { ServiceDef } from '@insler/service';

import type { GeneratedFile, GeneratorOptions, GeneratorPlugin } from '../types.js';

/**
 * Secret-binding generation (#0015).
 *
 * A {@link GeneratorPlugin} that turns each service's *logical* `needs` into a
 * physical [external-secrets.io](https://external-secrets.io) `ExternalSecret`
 * CRD. Each need maps to a secret path by a single, fleet-wide naming
 * convention — `{environment}/services/{service-name}/{need-name}` — keyed on
 * the service's full declared name (namespace segments included). The operator
 * configures the convention (store reference, refresh, workload identity) *once*
 * here; it then applies uniformly to every service in the manifest. This is the
 * PRD's "secret wiring is platform logic written once, not repeated across every
 * service" (US-3/US-4/US-5).
 *
 * Boundary: this plugin imports only the `FleetManifest` *model* (via the
 * service declarations it carries) from `@insler/service` — never
 * `@insler/platform/fleet`'s filesystem scanner. It does no
 * I/O; the engine writes. Output is pure and deterministic: identical
 * manifest + options always yield byte-identical files in a stable order.
 *
 * Deferred to the Kubernetes generator (#0012), NOT emitted here: mounting the
 * generated K8s `Secret` into a service's pod spec and wiring the
 * workload-identity annotation onto the `ServiceAccount`. This plugin emits the
 * `ExternalSecret` plus the reference contract (the deterministic
 * `{service}-{need}` Secret name) that #0012 consumes.
 */

/** Which external-secrets store the resolved secret is fetched from. */
export interface SecretStoreRef {
  /**
   * The store's name in the cluster. Opaque to this plugin and never validated:
   * it may name any external-secrets backend (AWS Secrets Manager, Vault, GCP
   * Secret Manager, …) — the convention is backend-agnostic (AC3).
   */
  readonly name: string;
  /**
   * Whether `name` refers to a cluster-scoped `ClusterSecretStore` or a
   * namespaced `SecretStore`. Defaults to `ClusterSecretStore`.
   */
  readonly kind?: 'ClusterSecretStore' | 'SecretStore';
}

/** A single annotation rendered onto the generated `ExternalSecret` metadata. */
export interface WorkloadIdentityAnnotation {
  /** The annotation key (e.g. `eks.amazonaws.com/role-arn`). */
  readonly key: string;
  /** The annotation value (e.g. the IAM role ARN / GCP service-account email). */
  readonly value: string;
}

/**
 * The fleet-wide secret-binding convention, written once by the operator. Only
 * {@link secretStoreRef} is required; everything else has a sensible default.
 */
export interface SecretBindingConfig {
  /** The backend-agnostic store every resolved secret is fetched from (AC3). */
  readonly secretStoreRef: SecretStoreRef;
  /**
   * How often external-secrets re-resolves the remote value. Defaults to `1h`
   * (the issue's example).
   */
  readonly refreshInterval?: string;
  /**
   * The key the resolved value is written under in the target K8s `Secret`.
   * Defaults to `connection-string` (the issue's example).
   */
  readonly secretKey?: string;
  /**
   * The CRD apiVersion to emit. Defaults to `external-secrets.io/v1beta1`.
   */
  readonly apiVersion?: string;
  /**
   * An optional workload-identity annotation rendered onto every generated
   * `ExternalSecret`'s metadata, enabling cloud-native (keyless) secret access
   * (AC5 / US-5). Omitted entirely when unset — no empty `annotations` block.
   */
  readonly workloadIdentityAnnotation?: WorkloadIdentityAnnotation;
}

const DEFAULT_REFRESH_INTERVAL = '1h';
const DEFAULT_SECRET_KEY = 'connection-string';
const DEFAULT_API_VERSION = 'external-secrets.io/v1beta1';
const DEFAULT_STORE_KIND = 'ClusterSecretStore' as const;

/**
 * Quote a YAML scalar value only when it needs it. Current inputs (store names,
 * convention paths, ARNs) are plain-safe and stay byte-identical; anything
 * carrying YAML-special characters (`:`, `#`, quotes, leading symbols, …) is
 * emitted as a JSON string, which YAML parses verbatim.
 */
function yamlValue(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._/:-]*$/.test(value) && !value.endsWith(':')
    ? value
    : JSON.stringify(value);
}

/** Stable comparator producing ascending string order. */
function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Render the full ExternalSecret YAML for one (service, need) pair. */
function renderExternalSecret(args: {
  readonly apiVersion: string;
  readonly resourceName: string;
  readonly refreshInterval: string;
  readonly secretKey: string;
  readonly remoteKey: string;
  readonly storeRef: Required<SecretStoreRef>;
  readonly annotation: WorkloadIdentityAnnotation | undefined;
}): string {
  const { apiVersion, resourceName, refreshInterval, secretKey, remoteKey, storeRef, annotation } =
    args;
  const lines: string[] = [
    `apiVersion: ${apiVersion}`,
    'kind: ExternalSecret',
    'metadata:',
    `  name: ${resourceName}`,
  ];
  if (annotation !== undefined) {
    lines.push(
      '  annotations:',
      `    ${yamlValue(annotation.key)}: ${yamlValue(annotation.value)}`
    );
  }
  lines.push(
    'spec:',
    `  refreshInterval: ${yamlValue(refreshInterval)}`,
    '  secretStoreRef:',
    `    name: ${yamlValue(storeRef.name)}`,
    `    kind: ${storeRef.kind}`,
    '  target:',
    `    name: ${resourceName}`,
    '  data:',
    `    - secretKey: ${yamlValue(secretKey)}`,
    '      remoteRef:',
    `        key: ${yamlValue(remoteKey)}`
  );
  return `${lines.join('\n')}\n`;
}

/**
 * Create the secret-binding {@link GeneratorPlugin} from a fleet-wide
 * {@link SecretBindingConfig}. The returned plugin emits one `ExternalSecret`
 * file per service `need`, named `secret-bindings/{service-name}-{need-name}.yaml`,
 * sorted by path for a stable diff.
 */
export function createSecretBindingPlugin(config: SecretBindingConfig): GeneratorPlugin {
  const apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
  const refreshInterval = config.refreshInterval ?? DEFAULT_REFRESH_INTERVAL;
  const secretKey = config.secretKey ?? DEFAULT_SECRET_KEY;
  const storeRef: Required<SecretStoreRef> = {
    name: config.secretStoreRef.name,
    kind: config.secretStoreRef.kind ?? DEFAULT_STORE_KIND,
  };
  const annotation = config.workloadIdentityAnnotation;

  return {
    name: 'secret-binding',
    generate(manifest, options: GeneratorOptions): readonly GeneratedFile[] {
      const files: GeneratedFile[] = [];

      for (const service of manifest.services as readonly ServiceDef[]) {
        // The full declared name (namespace segments included) keys both the
        // resource name and the remote path, so two services sharing an
        // own-name in different namespaces never collide — and the path stays
        // consistent with the serverless target's #0015 convention path.
        // Dots flatten to dashes in the resource name to keep it DNS-safe.
        const servicePrefix = service.name.replace(/\./g, '-');
        for (const need of service.needRefs) {
          const resourceName = `${servicePrefix}-${need.name}`;
          // {environment}/services/{service-name}/{need-name}.
          const remoteKey = `${options.environment}/services/${service.name}/${need.name}`;
          files.push({
            path: `secret-bindings/${resourceName}.yaml`,
            content: renderExternalSecret({
              apiVersion,
              resourceName,
              refreshInterval,
              secretKey,
              remoteKey,
              storeRef,
              annotation,
            }),
            format: 'yaml',
          });
        }
      }

      // Deterministic: stable sort by output path.
      return files.sort((a, b) => byString(a.path, b.path));
    },
  };
}
