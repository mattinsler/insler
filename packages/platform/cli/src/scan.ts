import { scanFleet } from '@insler/platform/fleet';
import type { FleetManifest } from '@insler/platform/fleet';

/**
 * The `insler scan` command (AC7). Discovers every service declaration under a
 * directory, builds the {@link FleetManifest}, and reports the result. On a
 * valid fleet it prints a summary (and the full manifest as JSON with
 * `--json`); on invalid input it prints each error with its file location(s)
 * and returns a non-zero exit code.
 *
 * Kept I/O-injectable (streams + the scan function) so it is unit-testable
 * without spawning a process or touching the real console.
 */

/** Where the command writes its human/JSON output and diagnostics. */
export interface ScanIO {
  /** Standard output sink. */
  readonly out: (line: string) => void;
  /** Standard error sink. */
  readonly err: (line: string) => void;
}

/** Parsed `insler scan` arguments. */
export interface ScanArgs {
  /** Directory to scan (defaults to the current working directory). */
  readonly cwd?: string;
  /** Emit the full manifest as JSON instead of a human summary. */
  readonly json?: boolean;
}

/** Render a valid manifest as a short human summary. */
function summarize(manifest: FleetManifest): string[] {
  const lines: string[] = [];
  lines.push(`Discovered ${manifest.services.length} service(s):`);
  for (const service of manifest.services) {
    lines.push(`  - ${service.name} (${service.kind})`);
  }
  lines.push(`Graph: ${manifest.graph.edges.length} edge(s)`);
  lines.push(`Exposed routes: ${manifest.expose.routes.length}`);
  return lines;
}

/**
 * Run the scan command. Returns the process exit code: `0` when the fleet is
 * valid, `1` when any cross-service constraint failed. The dependency on
 * `scanFleet` is injectable so tests can drive it with a stub.
 */
export async function runScan(
  args: ScanArgs,
  io: ScanIO,
  scan: typeof scanFleet = scanFleet
): Promise<number> {
  const result = await scan(args.cwd !== undefined ? { cwd: args.cwd } : {});

  if (result.errors.length > 0) {
    io.err(`Fleet scan failed with ${result.errors.length} error(s):`);
    for (const error of result.errors) {
      const where = error.files.length > 0 ? ` (${error.files.join(', ')})` : '';
      io.err(`  [${error.kind}] ${error.message}${where}`);
    }
    return 1;
  }

  const manifest = result.manifest as FleetManifest;

  if (args.json === true) {
    io.out(JSON.stringify(manifest, null, 2));
  } else {
    for (const line of summarize(manifest)) {
      io.out(line);
    }
  }

  return 0;
}
