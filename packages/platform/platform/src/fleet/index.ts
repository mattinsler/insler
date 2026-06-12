/**
 * `@insler/platform/fleet` — the scanner + desired-state model for an entire fleet.
 *
 * Discovers every `defineService` declaration across a tree, evaluates them,
 * and folds them into a {@link FleetManifest}: the unified collection of every
 * service's intent (services + dependency graph + external routing table) with
 * cross-service constraints validated. The manifest is the input the generator
 * (#0011+) derives all physical artifacts from.
 */

export { buildFleetManifest } from './manifest.js';
export type {
  FleetEdge,
  FleetError,
  FleetExpose,
  FleetGraph,
  FleetManifest,
  FleetResult,
  FleetRoute,
  ScannedService,
} from './manifest.js';
export { discoverServices, scanFleet } from './scanner.js';
export type { ScanOptions } from './scanner.js';
