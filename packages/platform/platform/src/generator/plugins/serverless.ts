import type { ScaleConfig, ServiceDef, ServiceKind } from '@insler/service';

import type { FleetManifest } from '../../fleet/index.js';
import type { GeneratedFile, GeneratorOptions, GeneratorPlugin } from '../types.js';

/**
 * The managed-serverless target (#0019).
 *
 * This is the second deployment target the generator can emit for — the
 * counterpart to the Kubernetes target (#0012). It proves the PRD's *dual-target*
 * model: the very same {@link ServiceDef} a service author declares with
 * `defineService` drives artifacts for *both* a customer's Kubernetes (the
 * enterprise/on-prem plane) and a managed-serverless container platform (the
 * SaaS plane), with no per-target authoring. The serverless target eliminates
 * cluster operations entirely (PRD US-31): no Deployment/Pod/ReplicaSet, no
 * KEDA — the platform manages scaling and (optionally) NATS-triggered work.
 *
 * Vendor choice is deferred by the PRD, so the *artifact shape* is owned by a
 * swappable {@link ServerlessPlatform} adapter; the plugin's mapping logic
 * (which `ServiceDef` field becomes which deployment concept) is
 * platform-independent. The default adapter targets Google Cloud Run
 * ({@link cloudRunPlatform}); swapping in Fly Machines / AWS App Runner / Railway
 * is a new adapter, not a new plugin.
 *
 * Boundary: this module reads only the `FleetManifest` *model* and the
 * `ServiceDef` shape — never the `@insler/platform/fleet` scanner, never the filesystem.
 * `generate` is pure and deterministic (the engine writes; the Notes require a
 * stable diff).
 */

/** How a service reaches the NATS fabric from the serverless plane. */
export type NatsConnectivity =
  /**
   * The platform runs a NATS *leaf node* the service dials locally; the leaf
   * node carries traffic up to the cluster. This is the SaaS-plane default and
   * mirrors the dev inner loop (PRD US-27): a service joins real queue groups
   * without every hop crossing the public internet.
   */
  | 'leaf-node'
  /** The service connects straight to the cluster's NATS URL. */
  | 'direct';

/** Run-level knobs the serverless target accepts beyond {@link GeneratorOptions}. */
export interface ServerlessConfig {
  /** Which platform adapter renders the artifacts. Defaults to {@link cloudRunPlatform}. */
  readonly platform?: ServerlessPlatform;
  /** How services reach NATS. Defaults to `'leaf-node'` (the SaaS-plane default). */
  readonly natsConnectivity?: NatsConnectivity;
  /**
   * The NATS endpoint a service connects to. For `'leaf-node'` this is the
   * local leaf address the platform injects (default
   * `nats://127.0.0.1:4222`); for `'direct'` it is the cluster URL. Carried
   * into the workload as `NATS_URL`.
   */
  readonly natsUrl?: string;
}

/**
 * The platform-independent deployment intent the plugin derives from one
 * {@link ServiceDef}. A {@link ServerlessPlatform} adapter renders this into the
 * vendor's concrete artifact. This is the seam that keeps vendor choice
 * deferred (PRD): the mapping from declaration to this shape is written once;
 * each platform only decides how to *spell* it.
 */
export interface ServerlessService {
  /** The service's stable identity (becomes the platform service name). */
  readonly name: string;
  /** The lifecycle kind — drives the scale floor and scale-to-zero eligibility. */
  readonly kind: ServiceKind;
  /** The deployment environment (e.g. `prod`), carried for naming/labels. */
  readonly environment: string;
  /** The resolved replica floor, already clamped to the platform's range. */
  readonly minScale: number;
  /** The resolved replica ceiling, already clamped to the platform's range. */
  readonly maxScale: number;
  /** How the workload reaches NATS, and at what URL. */
  readonly nats: {
    readonly connectivity: NatsConnectivity;
    readonly url: string;
  };
  /**
   * The secret bindings the workload needs, one per logical `need`. Each carries
   * the convention path (#0015) the platform's secret manager resolves and the
   * env var the value is injected as. This plugin only *references* the secret
   * model — it does not provision the backing secret (that is #0015).
   */
  readonly secrets: readonly ServerlessSecretBinding[];
}

/** One logical-need → platform-secret binding for a serverless workload. */
export interface ServerlessSecretBinding {
  /** The logical need name as declared (e.g. `orders-db`). */
  readonly need: string;
  /**
   * The convention secret path the platform's secret manager resolves
   * (`{environment}/services/{service}/{need}`, the #0015 convention). The
   * physical secret itself is out of scope here (#0015 owns provisioning).
   */
  readonly path: string;
  /** The environment variable the secret value is injected into the workload as. */
  readonly env: string;
}

/**
 * The constraints a serverless platform imposes on scaling, plus how it renders
 * a {@link ServerlessService} into artifacts. Swap the adapter to retarget the
 * plugin to a different vendor without touching the mapping logic.
 */
export interface ServerlessPlatform {
  /** Stable platform id, surfaced in artifact paths so two targets never collide. */
  readonly id: string;
  /**
   * Hard floor the platform allows for the minimum scale (e.g. Cloud Run allows
   * `0` for scale-to-zero). A service's resolved `minScale` is clamped to this.
   */
  readonly minScaleFloor: number;
  /** Hard ceiling the platform allows for the maximum scale; resolved `maxScale` is clamped to this. */
  readonly maxScaleCeiling: number;
  /** Render one derived service into its platform-specific artifact(s). */
  render(service: ServerlessService): readonly GeneratedFile[];
}

/** Clamp `value` into the inclusive `[lo, hi]` range. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

/**
 * Resolve the effective scale window for a service against a platform's limits.
 *
 * Starts from the declared `scale` (if any), falls back to the kind's
 * operational floor (ephemeral → 0, persistent/workflow → 1), then clamps both
 * ends into the platform's allowed range and guarantees `min <= max`. This is
 * "scale min/max respected within platform constraints" (AC5): a declared
 * window is honored exactly when it fits, and clamped — never silently dropped —
 * when it exceeds what the platform supports.
 */
function resolveScale(
  kind: ServiceKind,
  scale: ScaleConfig | undefined,
  platform: ServerlessPlatform
): { minScale: number; maxScale: number } {
  // Per-kind floor: only ephemeral may scale to zero; persistent/workflow hold >= 1.
  const kindFloor = kind === 'ephemeral' ? 0 : 1;
  const declaredMin = scale?.min ?? kindFloor;
  // Default ceiling tracks the floor when undeclared so an undeclared service
  // gets a sane, deterministic single-instance window rather than the platform max.
  const declaredMax = scale?.max ?? Math.max(declaredMin, 1);

  const minScale = clamp(declaredMin, platform.minScaleFloor, platform.maxScaleCeiling);
  const maxScale = clamp(Math.max(declaredMax, minScale), minScale, platform.maxScaleCeiling);

  return { minScale, maxScale };
}

/** The #0015 secret-path convention. Referenced here; provisioning is #0015's. */
function secretPath(environment: string, service: string, need: string): string {
  return `${environment}/services/${service}/${need}`;
}

/**
 * Derive the env var a logical need's secret is injected as (e.g. `orders-db` →
 * `ORDERS_DB`). A need starting with a digit is prefixed with `_` so the result
 * is always a valid POSIX identifier (e.g. `2fa-secret` → `_2FA_SECRET`).
 */
function secretEnv(need: string): string {
  const name = need.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

/** Derive the platform-independent {@link ServerlessService} from one declaration. */
function deriveService(
  service: ServiceDef,
  environment: string,
  platform: ServerlessPlatform,
  config: ServerlessConfig
): ServerlessService {
  const { minScale, maxScale } = resolveScale(service.kind, service.scale, platform);

  const connectivity: NatsConnectivity = config.natsConnectivity ?? 'leaf-node';
  const url =
    config.natsUrl ?? (connectivity === 'leaf-node' ? 'nats://127.0.0.1:4222' : 'nats://nats:4222');

  // needRefs is always present (empty when no needs declared) — sort by need
  // name for deterministic output.
  const secrets: ServerlessSecretBinding[] = [...service.needRefs]
    .map((ref) => ref.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((need) => ({
      need,
      path: secretPath(environment, service.name, need),
      env: secretEnv(need),
    }));

  return {
    name: service.name,
    kind: service.kind,
    environment,
    minScale,
    maxScale,
    nats: { connectivity, url },
    secrets,
  };
}

// --- YAML rendering (tiny, scoped to the shapes this plugin emits) ---

function yamlString(value: string): string {
  // Quote to keep values like URLs / paths unambiguous and the output stable.
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The Google Cloud Run adapter (default). Renders a Knative-style
 * `serving.knative.dev/v1` Service: scale via the `autoscaling.knative.dev`
 * min/maxScale annotations, NATS via plain env, and secrets via Secret
 * Manager-backed env (`valueFrom.secretKeyRef`) keyed on the #0015 convention
 * path. Cloud Run allows scale-to-zero, so `minScaleFloor` is `0`.
 */
export const cloudRunPlatform: ServerlessPlatform = {
  id: 'cloud-run',
  minScaleFloor: 0,
  // Cloud Run's per-service max instances ceiling.
  maxScaleCeiling: 1000,
  render(service: ServerlessService): readonly GeneratedFile[] {
    const env: string[] = [
      '            - name: NATS_URL',
      `              value: ${yamlString(service.nats.url)}`,
      '            - name: NATS_CONNECTIVITY',
      `              value: ${yamlString(service.nats.connectivity)}`,
    ];
    for (const secret of service.secrets) {
      // Knative/Cloud Run secretKeyRef: `name` is the secret resource (the
      // #0015 convention path), `key` selects the version within it.
      env.push(
        `            - name: ${secret.env}`,
        '              valueFrom:',
        '                secretKeyRef:',
        `                  name: ${yamlString(secret.path)}`,
        '                  key: latest'
      );
    }

    const lines = [
      'apiVersion: serving.knative.dev/v1',
      'kind: Service',
      'metadata:',
      `  name: ${yamlString(service.name)}`,
      '  labels:',
      `    insler.dev/environment: ${yamlString(service.environment)}`,
      `    insler.dev/kind: ${yamlString(service.kind)}`,
      'spec:',
      '  template:',
      '    metadata:',
      '      annotations:',
      `        autoscaling.knative.dev/minScale: ${yamlString(String(service.minScale))}`,
      `        autoscaling.knative.dev/maxScale: ${yamlString(String(service.maxScale))}`,
      '    spec:',
      '      containers:',
      `        - image: ${yamlString(`insler/${service.name}:latest`)}`,
      '          env:',
      ...env,
      '',
    ];

    return [
      {
        path: `${cloudRunPlatform.id}/${service.name}.service.yaml`,
        content: `${lines.join('\n')}`,
        format: 'yaml',
      },
    ];
  },
};

/**
 * Build the managed-serverless generator plugin (#0019).
 *
 * Emits artifacts only when the run's `target` is `'serverless'` — for any other
 * target it contributes nothing, so it composes alongside the Kubernetes target
 * (#0012) on the same engine, against the same manifest, without colliding. That
 * target-gated coexistence is the dual-target model at the plugin level: one
 * `ServiceDef`, two targets, selected by `options.target`.
 *
 * @param config optional platform adapter + NATS connectivity overrides.
 */
export function serverlessPlugin(config: ServerlessConfig = {}): GeneratorPlugin {
  const platform = config.platform ?? cloudRunPlatform;

  return {
    name: 'serverless',
    generate(manifest: FleetManifest, options: GeneratorOptions): readonly GeneratedFile[] {
      if (options.target !== 'serverless') {
        return [];
      }
      // Sort services by name for deterministic output regardless of discovery order.
      const services = [...manifest.services].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      );
      return services.flatMap((service) =>
        platform.render(deriveService(service, options.environment, platform, config))
      );
    },
  };
}
