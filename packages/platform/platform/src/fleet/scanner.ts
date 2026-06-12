import { isAbsolute, resolve } from 'node:path';

import type { ServiceDef } from '@insler/service';

import { buildFleetManifest } from './manifest.js';
import type { FleetResult, ScannedService } from './manifest.js';

/**
 * Convention-based discovery of service declarations. The scanner walks the
 * tree, imports every candidate module, and extracts the {@link ServiceDef}
 * objects each module exports — so adding a service is a single new declaration
 * file with no edits elsewhere (US-37). The discovered declarations are then
 * folded into a {@link FleetManifest} (`buildFleetManifest`), the desired state
 * the generator consumes.
 *
 * The scanner must be fast enough to run on every change in development
 * (auto-convergence) and reliable enough to be the source of truth for
 * production plans, so it does no codegen of its own — it only collects and
 * validates intent.
 */

/** Options controlling `scanFleet` discovery. */
export interface ScanOptions {
  /** The directory to scan, recursively. Defaults to the current working dir. */
  readonly cwd?: string;
  /**
   * Glob patterns (relative to `cwd`) selecting candidate declaration files.
   * Defaults to the convention: any `*.service.ts` / `*.def.ts` file. A file
   * that matches but exports no {@link ServiceDef} is simply skipped, so a
   * broader pattern is safe.
   */
  readonly patterns?: readonly string[];
  /** Glob patterns to exclude. Defaults to common build/dependency dirs. */
  readonly ignore?: readonly string[];
}

/** The default discovery convention: declaration files end in `.service` / `.def`. */
const DEFAULT_PATTERNS: readonly string[] = ['**/*.service.ts', '**/*.def.ts'];

/** Directories never worth scanning. */
const DEFAULT_IGNORE: readonly string[] = ['**/node_modules/**', '**/dist/**', '**/coverage/**'];

/** A `ServiceDef` is any frozen export carrying the `type: 'service'` tag. */
function isServiceDef(value: unknown): value is ServiceDef {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'service' &&
    typeof (value as { name?: unknown }).name === 'string'
  );
}

/** Pull every `ServiceDef` out of an imported module's exports. */
function serviceDefsFromModule(mod: Record<string, unknown>): ServiceDef[] {
  const defs: ServiceDef[] = [];
  for (const value of Object.values(mod)) {
    if (isServiceDef(value)) {
      defs.push(value);
    }
  }
  return defs;
}

/**
 * Discover and load every service declaration under `cwd`, returning the
 * located declarations in stable (sorted-by-file) order. Exposed separately
 * from {@link scanFleet} so callers (and tests) can inspect what was discovered
 * before the manifest is built.
 *
 * Each matched file is imported once; any export that is a {@link ServiceDef} is
 * collected, paired with that file's absolute path so downstream validation can
 * report errors with locations (AC6). Files that export no declaration are
 * skipped silently.
 */
export async function discoverServices(options: ScanOptions = {}): Promise<ScannedService[]> {
  const cwd = options.cwd !== undefined ? resolve(options.cwd) : process.cwd();
  const patterns = options.patterns ?? DEFAULT_PATTERNS;
  const ignore = options.ignore ?? DEFAULT_IGNORE;

  const files = new Set<string>();
  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern);
    for await (const match of glob.scan({ cwd, absolute: true, onlyFiles: true })) {
      if (!ignore.some((ig) => new Bun.Glob(ig).match(match))) {
        files.add(match);
      }
    }
  }

  const scanned: ScannedService[] = [];
  for (const file of [...files].sort()) {
    const specifier = isAbsolute(file) ? file : resolve(cwd, file);
    const mod = (await import(specifier)) as Record<string, unknown>;
    for (const service of serviceDefsFromModule(mod)) {
      scanned.push({ service, file });
    }
  }

  return scanned;
}

/**
 * Scan the tree for service declarations and build the complete
 * {@link FleetManifest} — discovery (`discoverServices`) followed by the pure
 * cross-service validation + assembly (`buildFleetManifest`). The returned
 * {@link FleetResult} carries the manifest when the fleet is valid, or a list of
 * located errors when a cross-service constraint fails.
 */
export async function scanFleet(options: ScanOptions = {}): Promise<FleetResult> {
  const scanned = await discoverServices(options);
  return buildFleetManifest(scanned);
}
