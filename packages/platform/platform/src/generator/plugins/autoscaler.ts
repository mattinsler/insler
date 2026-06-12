import type { ResolvedScaleConfig, ScaleSignal, ServiceDef } from '@insler/service';

import type { GeneratedFile, GeneratorOptions, GeneratorPlugin } from '../types.js';

/**
 * Autoscaler generator plugin (#0013) — turns each service's resolved scale
 * config into a KEDA `ScaledObject`.
 *
 * KEDA is the platform's autoscaler: a `ScaledObject` binds a workload to one or
 * more *triggers* (scalers), and KEDA drives the replica count between
 * `minReplicaCount` and `maxReplicaCount` off those signals. This plugin maps a
 * service's effective scale signal (the kind-derived default or the author's
 * override — see `@insler/service`'s `resolveScale`) to the right scaler:
 *
 * - `queue-depth` (the `ephemeral` default) → a **NATS JetStream** scaler that
 *   watches the service's durable consumer's pending/lag count. This is the
 *   piece that makes ephemeral scale-to-zero work (min 0): no pending messages →
 *   no replicas; a message arrives → KEDA activates the deployment.
 * - `cpu` (the `persistent` default) → a **CPU** utilization scaler. Persistent
 *   services hold a replica floor (>= 1), so they never scale to zero.
 * - `task-queue-backlog` (the `workflow` default) → an **external** scaler that
 *   watches the Temporal task-queue backlog. Workflows also keep a floor >= 1.
 * - `rps` / `custom` (HTTP-edge / escape-hatch signals an author may select) →
 *   an `external` scaler stub keyed on the signal name, so the output stays
 *   valid KEDA even for signals the platform wires up downstream.
 *
 * Boundary: this plugin imports only the *model* (`ServiceDef` /
 * `ResolvedScaleConfig` / `ScaleSignal`) from `@insler/service`; it never
 * touches `@insler/platform/fleet`'s scanner. `generate` is pure, deterministic, and does
 * no I/O — the engine writes (see {@link GeneratorPlugin}).
 */

/**
 * Tunable scaling thresholds and platform endpoints for the autoscaler plugin.
 * Every field is optional; omitted fields fall back to the defaults below. These
 * are the operator-supplied knobs the issue calls "custom scaling thresholds"
 * (AC6) plus the per-environment NATS endpoint/stream wiring.
 */
export interface AutoscalerOptions {
  /** Pending-message lag at which the NATS JetStream scaler adds a replica. */
  readonly natsLagThreshold?: number;
  /** Target CPU utilization (percentage) for the CPU scaler. */
  readonly cpuThreshold?: number;
  /** Target task-queue backlog depth for the workflow scaler. */
  readonly taskQueueBacklogThreshold?: number;
  /** Replica ceiling used when a service declares no `scale.max`. */
  readonly defaultMaxReplicas?: number;
  /** NATS monitoring endpoint the JetStream scaler polls (`host:port`). */
  readonly natsServerMonitoringEndpoint?: string;
  /** The JetStream account the RPC stream lives in. */
  readonly natsAccount?: string;
  /** The JetStream stream that carries RPC traffic. */
  readonly natsStream?: string;
}

interface ResolvedAutoscalerOptions {
  readonly natsLagThreshold: number;
  readonly cpuThreshold: number;
  readonly taskQueueBacklogThreshold: number;
  readonly defaultMaxReplicas: number;
  readonly natsServerMonitoringEndpoint: string;
  readonly natsAccount: string;
  readonly natsStream: string;
}

const DEFAULTS: ResolvedAutoscalerOptions = {
  natsLagThreshold: 10,
  cpuThreshold: 70,
  taskQueueBacklogThreshold: 10,
  defaultMaxReplicas: 50,
  natsServerMonitoringEndpoint: 'nats.default.svc.cluster.local:8222',
  natsAccount: '$G',
  natsStream: 'rpc',
};

/** A single KEDA trigger (scaler) with string-valued metadata, as KEDA expects. */
interface Trigger {
  readonly type: string;
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * Pick the KEDA trigger for a service's effective scale signal. Pure mapping;
 * `kind`-derived floors are already baked into `effectiveScale` upstream.
 */
function triggerFor(
  service: ServiceDef,
  scale: ResolvedScaleConfig,
  opts: ResolvedAutoscalerOptions
): Trigger {
  const signal: ScaleSignal = scale.on;
  switch (signal) {
    case 'queue-depth':
      // NATS JetStream consumer-lag scaler — the ephemeral scale-to-zero signal.
      return {
        type: 'nats-jetstream',
        metadata: {
          natsServerMonitoringEndpoint: opts.natsServerMonitoringEndpoint,
          account: opts.natsAccount,
          stream: opts.natsStream,
          consumer: service.name,
          lagThreshold: String(opts.natsLagThreshold),
        },
      };
    case 'cpu':
      return {
        type: 'cpu',
        metadata: { type: 'Utilization', value: String(opts.cpuThreshold) },
      };
    case 'task-queue-backlog':
      // External scaler watching the Temporal task-queue backlog.
      return {
        type: 'external',
        metadata: {
          scalerAddress: 'temporal-scaler.default.svc.cluster.local:8080',
          taskQueue: service.taskQueue ?? service.name,
          targetQueueSize: String(opts.taskQueueBacklogThreshold),
        },
      };
    case 'rps':
    case 'custom':
      // HTTP-edge / escape-hatch signals: emit a valid external-scaler stub keyed
      // on the signal so the document stays valid KEDA. The concrete RPS source
      // (edge gateway / Prometheus) is wired up by the routing generator (#0014).
      return {
        type: 'external',
        metadata: { scaler: signal, service: service.name },
      };
  }
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * Render one service's ScaledObject as deterministic block-style YAML. Metadata
 * keys are emitted in declaration order (the mapping above fixes them), so the
 * same input always produces byte-identical output.
 */
function renderScaledObject(
  service: ServiceDef,
  scale: ResolvedScaleConfig,
  opts: ResolvedAutoscalerOptions
): string {
  const trigger = triggerFor(service, scale, opts);
  const max = scale.max ?? opts.defaultMaxReplicas;

  const lines: string[] = [
    'apiVersion: keda.sh/v1alpha1',
    'kind: ScaledObject',
    'metadata:',
    `  name: ${service.name}`,
    'spec:',
    '  scaleTargetRef:',
    `    name: ${service.name}`,
    `  minReplicaCount: ${scale.min}`,
    `  maxReplicaCount: ${max}`,
    '  triggers:',
    `    - type: ${trigger.type}`,
    '      metadata:',
    ...Object.entries(trigger.metadata).map(([k, v]) => `        ${k}: ${quote(v)}`),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Create the autoscaler generator plugin. Optionally tune the scaling thresholds
 * and NATS wiring via {@link AutoscalerOptions}; omitted fields use the defaults.
 * Emits one `keda/<service>.yaml` ScaledObject per service.
 */
export function autoscalerPlugin(options: AutoscalerOptions = {}): GeneratorPlugin {
  const opts: ResolvedAutoscalerOptions = {
    natsLagThreshold: options.natsLagThreshold ?? DEFAULTS.natsLagThreshold,
    cpuThreshold: options.cpuThreshold ?? DEFAULTS.cpuThreshold,
    taskQueueBacklogThreshold:
      options.taskQueueBacklogThreshold ?? DEFAULTS.taskQueueBacklogThreshold,
    defaultMaxReplicas: options.defaultMaxReplicas ?? DEFAULTS.defaultMaxReplicas,
    natsServerMonitoringEndpoint:
      options.natsServerMonitoringEndpoint ?? DEFAULTS.natsServerMonitoringEndpoint,
    natsAccount: options.natsAccount ?? DEFAULTS.natsAccount,
    natsStream: options.natsStream ?? DEFAULTS.natsStream,
  };

  return {
    name: 'keda-autoscaler',
    generate(manifest, _options: GeneratorOptions): readonly GeneratedFile[] {
      return [...manifest.services]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((service) => ({
          path: `keda/${service.name}.yaml`,
          content: renderScaledObject(service, service.effectiveScale, opts),
          format: 'yaml' as const,
        }));
    },
  };
}
