import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// Shared derivation for the per-subsystem branding tests (the README front
// door and the docs site's reference coverage — subsystem-branding issue 0003
// and its replications): a subsystem's consumer-facing public surface,
// derived from manifests and directories so the README map and the site's
// reference pages cannot silently drift from the published packages.

export interface SubsystemSurface {
  /** The umbrella core package name (`@insler/<subsystem>`). */
  readonly umbrellaName: string;
  /**
   * Every umbrella entrypoint a consumer imports: the subpath entrypoints of
   * a multi-entrypoint umbrella (whose root is the 0-to-value re-export), or
   * the root entrypoint itself when the umbrella is single-entrypoint.
   */
  readonly umbrellaEntrypoints: string[];
  /**
   * Every adapter package of the subsystem: the non-private siblings of the
   * umbrella under `packages/<subsystem>/`. (Private siblings — the website
   * and integration packages of ADR-0003 move 3 — are branding
   * infrastructure, not adapters, and stay out of the consumer-facing map.)
   */
  readonly adapterPackages: string[];
}

export async function discoverSubsystemSurface(
  repoRoot: string,
  subsystem: string
): Promise<SubsystemSurface> {
  const subsystemDir = join(repoRoot, 'packages', subsystem);
  const umbrellaPkg = await Bun.file(join(subsystemDir, subsystem, 'package.json')).json();
  const umbrellaName = umbrellaPkg.name as string;

  const subpathEntrypoints = Object.keys(umbrellaPkg.exports as Record<string, unknown>)
    .filter((key) => key !== '.' && key !== './package.json')
    .map((key) => `${umbrellaName}${key.slice(1)}`);
  const umbrellaEntrypoints = subpathEntrypoints.length > 0 ? subpathEntrypoints : [umbrellaName];

  const adapterPackages: string[] = [];
  for (const entry of readdirSync(subsystemDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === subsystem || entry.name === 'node_modules') continue;
    const manifest = Bun.file(join(subsystemDir, entry.name, 'package.json'));
    if (!(await manifest.exists())) continue;
    const sibling = await manifest.json();
    if (sibling.private !== true) adapterPackages.push(sibling.name as string);
  }
  adapterPackages.sort();

  return { umbrellaName, umbrellaEntrypoints, adapterPackages };
}
