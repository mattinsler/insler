/**
 * `@insler/platform/generator` — the pluggable codegen engine.
 *
 * Turns a {@link FleetManifest} (the desired-state model from `@insler/platform/fleet`)
 * into a deterministic set of artifacts. The engine (`createGenerator`) is
 * artifact-agnostic: every concrete output is a {@link GeneratorPlugin}
 * registered with `.use(...)`. The engine handles ordering, collision
 * detection, writing to an output directory, dry-run preview, and the
 * file-level diff against a previous generation (AC6) that feeds plan/diff.
 *
 * Boundary: this package depends only on the `FleetManifest` *model* from
 * `@insler/platform/fleet`, never on its filesystem scanner — callers may supply their
 * own manifest (partial adoption).
 */

export { createGenerator } from './generator.js';
export { fleetInventoryPlugin } from './example-plugin.js';
export { dataStoreClaimsPlugin } from './plugins/data-store-claims.js';
export type {
  DataStoreClaimsConfig,
  DataStoreTypeDefaults,
  ProvisionPolicy,
} from './plugins/data-store-claims.js';
export { cloudRunPlatform, serverlessPlugin } from './plugins/serverless.js';
export type {
  NatsConnectivity,
  ServerlessConfig,
  ServerlessPlatform,
  ServerlessSecretBinding,
  ServerlessService,
} from './plugins/serverless.js';
export { edgeRoutingPlugin } from './plugins/edge-routing.js';
export type {
  EdgeHttpMethod,
  EdgeRoute,
  EdgeRoutingTable,
  EdgeStreamMode,
} from './plugins/edge-routing.js';
export { natsCredentialsPlugin } from './plugins/nats-credentials.js';
export { createSecretBindingPlugin } from './plugins/secret-binding.js';
export type {
  SecretBindingConfig,
  SecretStoreRef,
  WorkloadIdentityAnnotation,
} from './plugins/secret-binding.js';
export { autoscalerPlugin } from './plugins/autoscaler.js';
export type { AutoscalerOptions } from './plugins/autoscaler.js';
export { kubernetesPlugin } from './plugins/kubernetes.js';
export type {
  KubernetesPlugin,
  KubernetesPluginConfig,
  ProbeConfig,
  ResourceQuantities,
  ResourceRequirements,
} from './plugins/kubernetes.js';
export type {
  GeneratedFile,
  GeneratedFileFormat,
  GenerationDiff,
  GenerationResult,
  Generator,
  GeneratorOptions,
  GeneratorPlugin,
  GeneratorTarget,
} from './types.js';
