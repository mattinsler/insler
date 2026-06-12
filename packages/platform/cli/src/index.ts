/**
 * `@insler/cli` — the `insler` binary.
 *
 * The full-adoption layer that composes the platform libraries behind a single
 * command-line tool. Today it exposes `insler scan` (over `@insler/platform/fleet`),
 * `insler generate` (over `@insler/platform/generator`), `insler plan` / `insler apply`
 * (over `@insler/platform/reconciler`), and `insler dev` (the development auto-converge
 * inner loop); future commands are added by their own issues. Keep this package
 * thin — it is command wiring, not platform logic.
 */

export { runApply } from './apply.js';
export type { ApplyArgs, ApplyIO } from './apply.js';
export { converge, runDev, watchDeclarations } from './dev.js';
export type {
  ConvergeReport,
  DevArgs,
  DevDeps,
  DevIO,
  DevSession,
  WatchHandle,
  WatchSource,
} from './dev.js';
export { runGenerate } from './generate.js';
export type { GenerateArgs, GenerateIO } from './generate.js';
export { runPlan } from './plan.js';
export type { PlanArgs, PlanIO } from './plan.js';
export { runScan } from './scan.js';
export type { ScanArgs, ScanIO } from './scan.js';
