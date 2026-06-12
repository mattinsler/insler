/**
 * Kubernetes manifest generator plugin (#0012).
 *
 * Turns every {@link ServiceDef} in a {@link FleetManifest} into the vanilla
 * Kubernetes resources that run it: a Deployment, a ServiceAccount (workload
 * identity), an optional ClusterIP Service, and an optional ConfigMap. The
 * output is plain K8s YAML — NOT Kustomize or Helm; Helm packaging (#0018) wraps
 * these manifests into a chart as a separate step, and autoscaling (KEDA/HPA,
 * #0013) is a separate plugin that consumes the same `effectiveScale`.
 *
 * Boundary (ADR-0002): this plugin imports only the *model* — `FleetManifest`
 * from `@insler/platform/fleet` and `ServiceDef`/`ServiceIdentity`/`IsolationTier` plus
 * `deriveIdentity` from `@insler/service`. It never reaches for fleet's scanner
 * or the disk; the engine writes, the plugin only renders. `generate` is pure
 * and deterministic: identical inputs always yield byte-identical files in a
 * stable order, so the generated diff is meaningful (AC8).
 *
 * The secret-binding naming convention (`{service}-{need}`) is referenced here
 * (the #0015 convention) but the secret *generator* itself is out of scope.
 */

import { deriveIdentity } from '@insler/service';
import type { IsolationTier, ServiceDef, ServiceEnv } from '@insler/service';

import type { FleetManifest } from '../../fleet/index.js';
import type { GeneratedFile, GeneratorOptions, GeneratorPlugin } from '../types.js';

/** Container resource requests/limits (a `cpu`/`memory` pair). */
export interface ResourceQuantities {
  /** CPU quantity (e.g. `100m`, `2`). */
  readonly cpu: string;
  /** Memory quantity (e.g. `128Mi`, `1Gi`). */
  readonly memory: string;
}

/** A container's resource requests and limits. */
export interface ResourceRequirements {
  /** Guaranteed resources the scheduler reserves. */
  readonly requests: ResourceQuantities;
  /** The ceiling the kubelet enforces. */
  readonly limits: ResourceQuantities;
}

/** A liveness/readiness probe over an HTTP endpoint on the workload port. */
export interface ProbeConfig {
  /** The HTTP path the kubelet GETs. */
  readonly path: string;
  /** Seconds before the first probe. */
  readonly initialDelaySeconds: number;
  /** Seconds between probes. */
  readonly periodSeconds: number;
}

/** Tunable inputs for the Kubernetes plugin; every field has a sensible default. */
export interface KubernetesPluginConfig {
  /** Default container resources (AC4); overridable per run. */
  readonly resources?: ResourceRequirements;
  /** The container port the workload listens on (health + metrics + traffic). */
  readonly port?: number;
  /** Liveness probe shape. */
  readonly livenessProbe?: ProbeConfig;
  /** Readiness probe shape. */
  readonly readinessProbe?: ProbeConfig;
  /**
   * Annotation key used to bind the ServiceAccount to a cloud workload identity
   * (e.g. GCP Workload Identity / IRSA). The qualified service identity is the
   * value (AC3).
   */
  readonly workloadIdentityAnnotation?: string;
}

/** The Kubernetes plugin: a {@link GeneratorPlugin} with a `configure` escape hatch. */
export interface KubernetesPlugin extends GeneratorPlugin {
  /** Return a new plugin instance with the given config merged over the defaults. */
  configure(config: KubernetesPluginConfig): KubernetesPlugin;
}

const DEFAULT_RESOURCES: ResourceRequirements = {
  requests: { cpu: '100m', memory: '128Mi' },
  limits: { cpu: '500m', memory: '256Mi' },
};

const DEFAULT_PORT = 8080;

const DEFAULT_LIVENESS: ProbeConfig = {
  path: '/healthz',
  initialDelaySeconds: 10,
  periodSeconds: 15,
};

const DEFAULT_READINESS: ProbeConfig = {
  path: '/readyz',
  initialDelaySeconds: 5,
  periodSeconds: 10,
};

const DEFAULT_WORKLOAD_IDENTITY_ANNOTATION = 'insler.dev/workload-identity';

interface ResolvedConfig {
  readonly resources: ResourceRequirements;
  readonly port: number;
  readonly livenessProbe: ProbeConfig;
  readonly readinessProbe: ProbeConfig;
  readonly workloadIdentityAnnotation: string;
}

function resolveConfig(config: KubernetesPluginConfig): ResolvedConfig {
  return {
    resources: config.resources ?? DEFAULT_RESOURCES,
    port: config.port ?? DEFAULT_PORT,
    livenessProbe: config.livenessProbe ?? DEFAULT_LIVENESS,
    readinessProbe: config.readinessProbe ?? DEFAULT_READINESS,
    workloadIdentityAnnotation:
      config.workloadIdentityAnnotation ?? DEFAULT_WORKLOAD_IDENTITY_ANNOTATION,
  };
}

// --- environment & identity helpers ---

/**
 * Map the run's free-form `environment` (`prod`/`dev`/`test`/…) to the
 * `ServiceEnv` the identity model keys off of, so the derived identity (and the
 * SA name / labels / annotations) line up with the rest of the platform.
 * Unknown values fall back to `production` (the identity model's own default).
 */
function toServiceEnv(environment: string): ServiceEnv {
  const e = environment.toLowerCase();
  if (e === 'test') return 'test';
  if (e === 'dev' || e === 'development') return 'development';
  return 'production';
}

/** Lower-case a string and replace any run of non-`[a-z0-9-]` with a single `-`. */
function dnsSafe(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The DNS-1123-safe Kubernetes resource name for a service: its namespace and
 * own-name segments joined with `-` (dots are not valid in resource names).
 * `default` namespace collapses to just the service name.
 */
function resourceName(def: ServiceDef, environment: string): string {
  const id = deriveIdentity(def, toServiceEnv(environment));
  const base = id.namespace === 'default' ? id.name : `${id.namespace}.${id.name}`;
  return dnsSafe(base);
}

// --- YAML emitter -------------------------------------------------------------
//
// A tiny, dependency-free, deterministic YAML emitter for the constrained
// subset K8s manifests use: nested maps, lists of maps/scalars, strings,
// numbers, booleans. Map keys are emitted in insertion order, so callers
// control the (stable) field ordering — that is what makes the output
// idempotent (AC8). We avoid adding a yaml dependency to keep the plugin
// self-contained.

type YamlValue = null | boolean | number | string | YamlValue[] | YamlNode;
interface YamlNode {
  readonly [key: string]: YamlValue;
}

function needsQuoting(s: string): boolean {
  if (s === '') return true;
  // quote anything that could be mis-parsed as a non-string scalar or that
  // contains YAML-significant characters.
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return true;
  if (/^-?\d+(\.\d+)?$/.test(s)) return true;
  if (/[:#{}[\],&*!|>'"%@`]/.test(s) || /^[\s-]/.test(s) || /\s$/.test(s)) return true;
  return false;
}

function renderScalar(value: boolean | number | string | null): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return needsQuoting(value) ? JSON.stringify(value) : value;
}

function isScalar(value: YamlValue): value is boolean | number | string | null {
  return value === null || typeof value !== 'object';
}

function emitNode(node: YamlValue[] | YamlNode, indent: number): string[] {
  const pad = ' '.repeat(indent);
  const lines: string[] = [];

  if (Array.isArray(node)) {
    if (node.length === 0) return [`${pad}[]`];
    for (const item of node) {
      if (isScalar(item)) {
        lines.push(`${pad}- ${renderScalar(item)}`);
      } else if (Array.isArray(item)) {
        lines.push(`${pad}-`);
        lines.push(...emitNode(item, indent + 2));
      } else {
        // list of maps: first key shares the `- ` line, the rest are indented.
        const childLines = emitNode(item, indent + 2);
        const first = childLines[0] ?? '';
        lines.push(`${pad}- ${first.slice(indent + 2)}`);
        lines.push(...childLines.slice(1));
      }
    }
    return lines;
  }

  const entries = Object.entries(node);
  if (entries.length === 0) return [`${pad}{}`];
  for (const [key, value] of entries) {
    if (isScalar(value)) {
      lines.push(`${pad}${key}: ${renderScalar(value)}`);
    } else if (Array.isArray(value) && value.length === 0) {
      lines.push(`${pad}${key}: []`);
    } else if (!Array.isArray(value) && Object.keys(value).length === 0) {
      lines.push(`${pad}${key}: {}`);
    } else {
      lines.push(`${pad}${key}:`);
      // lists are emitted at the SAME indent as their key (standard K8s style).
      lines.push(...emitNode(value, Array.isArray(value) ? indent : indent + 2));
    }
  }
  return lines;
}

/** Render a single K8s document to YAML text (trailing newline, no `---`). */
function toYaml(doc: YamlNode): string {
  return `${emitNode(doc, 0).join('\n')}\n`;
}

// --- resource builders --------------------------------------------------------

/**
 * The RuntimeClass name for an isolation tier (AC2). `default` is a standard
 * container (runc) and needs no RuntimeClass — the pod uses the cluster default,
 * so we omit the field entirely. `gvisor`/`microvm` map to their RuntimeClass.
 */
function runtimeClassName(isolation: IsolationTier): string | undefined {
  switch (isolation) {
    case 'gvisor':
      return 'gvisor';
    case 'microvm':
      return 'microvm';
    case 'default':
      return undefined;
  }
}

/** Common labels every resource for a service carries. */
function labelsFor(def: ServiceDef, environment: string): YamlNode {
  const id = deriveIdentity(def, toServiceEnv(environment));
  return {
    'app.kubernetes.io/name': dnsSafe(id.name),
    'app.kubernetes.io/part-of': dnsSafe(id.namespace),
    'app.kubernetes.io/managed-by': 'insler',
    'insler.dev/environment': id.environment,
  };
}

/** The single label value pods/Services select on (the service's own name). */
function selectorLabel(def: ServiceDef, environment: string): string {
  return dnsSafe(deriveIdentity(def, toServiceEnv(environment)).name);
}

/**
 * The NATS queue group a service's replicas share — its qualified identity, so
 * every replica of one service load-balances one subscription (AC6).
 */
function queueGroupFor(def: ServiceDef, environment: string): string {
  return deriveIdentity(def, toServiceEnv(environment)).qualifiedName;
}

/**
 * The secret name a `{service}-{need}` binding resolves to (#0015 naming
 * convention — referenced, not owned here). The service segment is the own-name
 * of the service identity.
 */
function secretNameFor(def: ServiceDef, environment: string, need: string): string {
  const id = deriveIdentity(def, toServiceEnv(environment));
  return dnsSafe(`${id.name}-${need}`);
}

function buildServiceAccount(
  def: ServiceDef,
  cfg: ResolvedConfig,
  options: GeneratorOptions
): YamlNode {
  const name = resourceName(def, options.environment);
  const id = deriveIdentity(def, toServiceEnv(options.environment));
  return {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: {
      name,
      labels: labelsFor(def, options.environment),
      annotations: {
        [cfg.workloadIdentityAnnotation]: id.qualifiedName,
      },
    },
  };
}

function buildContainer(def: ServiceDef, cfg: ResolvedConfig, options: GeneratorOptions): YamlNode {
  const name = resourceName(def, options.environment);

  // AC6 — queue group passed as env (and as an arg the entrypoint can read).
  const queueGroup = queueGroupFor(def, options.environment);
  const env: YamlValue[] = [
    { name: 'INSLER_SERVICE_NAME', value: def.name },
    { name: 'INSLER_QUEUE_GROUP', value: queueGroup },
  ];
  if (def.kind === 'workflow' && def.taskQueue !== undefined) {
    env.push({ name: 'INSLER_TASK_QUEUE', value: def.taskQueue });
  }

  const probe = (p: typeof cfg.livenessProbe): YamlNode => ({
    httpGet: { path: p.path, port: cfg.port },
    initialDelaySeconds: p.initialDelaySeconds,
    periodSeconds: p.periodSeconds,
  });

  const container: Record<string, YamlValue> = {
    name,
    image: `${def.name}:latest`,
    args: ['--queue-group', queueGroup],
    ports: [{ containerPort: cfg.port, name: 'http' }],
    env,
  };

  // needs -> secret-backed env via envFrom, one secret per {service}-{need}.
  const needs = def.needs ?? [];
  if (needs.length > 0) {
    container['envFrom'] = needs.map((need) => ({
      secretRef: { name: secretNameFor(def, options.environment, need) },
    }));
  }

  container['resources'] = {
    requests: { cpu: cfg.resources.requests.cpu, memory: cfg.resources.requests.memory },
    limits: { cpu: cfg.resources.limits.cpu, memory: cfg.resources.limits.memory },
  };
  container['livenessProbe'] = probe(cfg.livenessProbe); // AC5
  container['readinessProbe'] = probe(cfg.readinessProbe); // AC5

  return container;
}

function buildDeployment(
  def: ServiceDef,
  cfg: ResolvedConfig,
  options: GeneratorOptions
): YamlNode {
  const name = resourceName(def, options.environment);
  const labels = labelsFor(def, options.environment);
  const runtimeClass = runtimeClassName(def.effectiveIsolation); // AC2

  // Replica floor comes from the effective scale (#0008). Scaling itself (KEDA/
  // HPA) is the autoscaler plugin's job (#0013); we only seed the floor.
  const replicas = def.effectiveScale.min;

  const podSpec: Record<string, YamlValue> = {
    serviceAccountName: name,
    ...(runtimeClass !== undefined ? { runtimeClassName: runtimeClass } : {}),
    containers: [buildContainer(def, cfg, options)],
  };

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, labels },
    spec: {
      replicas,
      selector: {
        matchLabels: { 'app.kubernetes.io/name': selectorLabel(def, options.environment) },
      },
      template: {
        metadata: { labels },
        spec: podSpec,
      },
    },
  };
}

function buildService(def: ServiceDef, cfg: ResolvedConfig, options: GeneratorOptions): YamlNode {
  const name = resourceName(def, options.environment);
  const labels = labelsFor(def, options.environment);
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, labels },
    spec: {
      type: 'ClusterIP',
      selector: { 'app.kubernetes.io/name': selectorLabel(def, options.environment) },
      ports: [{ name: 'http', port: cfg.port, targetPort: cfg.port }],
    },
  };
}

function buildConfigMap(def: ServiceDef, options: GeneratorOptions): YamlNode {
  const name = resourceName(def, options.environment);
  const labels = labelsFor(def, options.environment);
  const data: Record<string, YamlValue> = {
    'service.name': def.name,
    'service.kind': def.kind,
    'nats.queue-group': queueGroupFor(def, options.environment),
  };
  if (def.kind === 'workflow' && def.taskQueue !== undefined) {
    data['temporal.task-queue'] = def.taskQueue;
  }
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name, labels },
    data,
  };
}

/** Sort services by name so output order is independent of discovery order (AC8). */
function sortedServices(manifest: FleetManifest): readonly ServiceDef[] {
  return [...manifest.services].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function generate(
  manifest: FleetManifest,
  options: GeneratorOptions,
  cfg: ResolvedConfig
): readonly GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const def of sortedServices(manifest)) {
    const name = resourceName(def, options.environment);
    files.push(
      {
        path: `kubernetes/${name}/serviceaccount.yaml`,
        content: toYaml(buildServiceAccount(def, cfg, options)),
        format: 'yaml',
      },
      {
        path: `kubernetes/${name}/deployment.yaml`,
        content: toYaml(buildDeployment(def, cfg, options)),
        format: 'yaml',
      },
      {
        path: `kubernetes/${name}/service.yaml`,
        content: toYaml(buildService(def, cfg, options)),
        format: 'yaml',
      },
      {
        path: `kubernetes/${name}/configmap.yaml`,
        content: toYaml(buildConfigMap(def, options)),
        format: 'yaml',
      }
    );
  }
  // Stable, path-sorted order for a meaningful diff (AC8).
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function makePlugin(config: KubernetesPluginConfig): KubernetesPlugin {
  const cfg = resolveConfig(config);
  return {
    name: 'kubernetes',
    generate: (manifest, options) => generate(manifest, options, cfg),
    configure: (next) => makePlugin({ ...config, ...next }),
  };
}

/**
 * The Kubernetes manifest generator plugin (#0012). Register it on the engine
 * with `.use(kubernetesPlugin)`, or tune resources/probes/port first via
 * `kubernetesPlugin.configure({ ... })`.
 */
export const kubernetesPlugin: KubernetesPlugin = makePlugin({});
