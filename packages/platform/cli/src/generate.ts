import { scanFleet } from '@insler/platform/fleet';
import type { FleetManifest } from '@insler/platform/fleet';
import { createGenerator, fleetInventoryPlugin } from '@insler/platform/generator';
import type { GeneratorOptions } from '@insler/platform/generator';

/**
 * The `insler generate` command (AC7). Scans a directory into a
 * {@link FleetManifest}, runs the codegen engine's registered plugins against
 * it, and either writes the artifacts to an output directory or — with
 * `--dry-run` — previews them to stdout. On an invalid fleet it prints each
 * error with its file location(s) and generates nothing (exit 1).
 *
 * This is the full-adoption wiring layer, so it is allowed to use the fleet
 * *scanner*; the generator engine it drives is not. Kept I/O-injectable
 * (streams + the scan function) so it is unit-testable without a process.
 */

/** Where the command writes its output and diagnostics. */
export interface GenerateIO {
  /** Standard output sink. */
  readonly out: (line: string) => void;
  /** Standard error sink. */
  readonly err: (line: string) => void;
}

/** Parsed `insler generate` arguments. */
export interface GenerateArgs {
  /** Directory to scan for service declarations (defaults to cwd). */
  readonly cwd?: string;
  /** Directory generated artifacts are written under (defaults to `./out`). */
  readonly outputDir?: string;
  /** Deployment target (defaults to `kubernetes`). */
  readonly target?: GeneratorOptions['target'];
  /** Environment name (defaults to `dev`). */
  readonly environment?: string;
  /** Preview artifacts to stdout instead of writing them. */
  readonly dryRun?: boolean;
}

/**
 * Run the generate command. Returns the process exit code: `0` on a valid
 * fleet, `1` when any cross-service constraint failed. The `scanFleet`
 * dependency is injectable so tests can drive it with a stub.
 */
export async function runGenerate(
  args: GenerateArgs,
  io: GenerateIO,
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
  const outputDir = args.outputDir ?? 'out';
  const options: GeneratorOptions = {
    target: args.target ?? 'kubernetes',
    outputDir,
    environment: args.environment ?? 'dev',
  };

  const generator = createGenerator().use(fleetInventoryPlugin);
  const generation = generator.generate(manifest, options);

  if (args.dryRun === true) {
    generator.dryRun(generation, (line) => io.out(line));
    return 0;
  }

  await generator.write(generation, outputDir);
  io.out(`Generated ${generation.files.length} file(s) into ${outputDir}`);
  return 0;
}
