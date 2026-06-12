import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { scanFleet } from '@insler/platform/fleet';
import type { FleetManifest } from '@insler/platform/fleet';
import { createGenerator, fleetInventoryPlugin } from '@insler/platform/generator';
import type { GeneratorOptions } from '@insler/platform/generator';
import { toResources } from '@insler/platform/reconciler';
import type {
  AuditRecord,
  AuditSink,
  Resource,
  SetAppliedOptions,
  StateProvider,
} from '@insler/platform/reconciler';

/**
 * Shared wiring for the `insler plan` and `insler apply` commands. Both scan a
 * directory into a {@link FleetManifest}, run the generator to derive the
 * desired-state artifacts, then reconcile against actual state read through a
 * {@link StateProvider}. This is the full-adoption layer, so it is allowed to
 * use the fleet *scanner*; the reconciler engine it drives is not.
 *
 * Real actual-state backends do not exist yet, so the CLI reads/writes actual
 * state from a JSON snapshot file (`--state`). A missing snapshot means an empty
 * actual state (everything is an add); `apply` writes the converged snapshot
 * back so a subsequent `plan` is a no-op — demonstrating convergence end-to-end.
 */

/** Where a reconcile command writes its output and diagnostics. */
export interface ReconcileIO {
  /** Standard output sink. */
  readonly out: (line: string) => void;
  /** Standard error sink. */
  readonly err: (line: string) => void;
}

/**
 * The conventional production environment name. `insler apply --env production`
 * routes through the gated apply (plan-match + audit trail, issue 0023); every
 * other environment keeps the ungated, fast-converge apply. The dev auto-converge
 * *policy* itself (#0022) is a separate downstream issue.
 */
export const PRODUCTION_ENV = 'production';

/**
 * Resolve the operator identity recorded in the production audit trail (issue
 * 0023 AC4). Prefers an explicit `--operator`, then `INSLER_OPERATOR`, then the
 * shell `USER`; falls back to `'unknown'` so a change is never recorded with an
 * empty principal.
 */
export function resolveOperator(explicit: string | undefined): string {
  return explicit ?? process.env.INSLER_OPERATOR ?? process.env.USER ?? 'unknown';
}

/**
 * An {@link AuditSink} that appends one JSON record per line (JSONL) to a file —
 * the CLI's durable, append-only production audit trail (issue 0023 AC4/AC6).
 * Append-only so the trail is tamper-evident; the parent directory is created on
 * demand. A real deployment swaps this for a centralized store behind the same
 * seam.
 */
export function createFileAuditSink(auditPath: string): AuditSink {
  return {
    async record(entry: AuditRecord): Promise<void> {
      await mkdir(dirname(auditPath), { recursive: true });
      await appendFile(auditPath, `${JSON.stringify(entry)}\n`, 'utf8');
    },
  };
}

/** A scanned, generated desired state plus a 0/1 exit code on scan failure. */
interface DesiredStateResult {
  /** The derived desired-state resources (absent on a scan failure). */
  readonly desired?: readonly Resource[];
  /** Exit code: `0` on a valid fleet, `1` when the scan reported errors. */
  readonly code: number;
}

/**
 * Scan a directory and derive the desired-state resource set from the generator.
 * Reports fleet errors with their file locations and returns `code: 1` (and no
 * desired state) when the scan fails — matching `insler generate`'s contract.
 */
export async function deriveDesiredState(
  cwd: string | undefined,
  environment: string | undefined,
  io: ReconcileIO,
  scan: typeof scanFleet = scanFleet
): Promise<DesiredStateResult> {
  const result = await scan(cwd !== undefined ? { cwd } : {});

  if (result.errors.length > 0) {
    io.err(`Fleet scan failed with ${result.errors.length} error(s):`);
    for (const error of result.errors) {
      const where = error.files.length > 0 ? ` (${error.files.join(', ')})` : '';
      io.err(`  [${error.kind}] ${error.message}${where}`);
    }
    return { code: 1 };
  }

  const manifest = result.manifest as FleetManifest;
  const options: GeneratorOptions = {
    target: 'kubernetes',
    outputDir: 'out',
    environment: environment ?? 'dev',
  };
  const generator = createGenerator().use(fleetInventoryPlugin);
  const generation = generator.generate(manifest, options);
  return { desired: toResources(generation.files), code: 0 };
}

/** The persisted shape of a state snapshot file. */
interface StateSnapshot {
  /** The live actual state. */
  readonly actual: readonly Resource[];
  /** The desired state recorded by the last successful apply. */
  readonly lastApplied: readonly Resource[];
}

async function readSnapshot(statePath: string): Promise<StateSnapshot> {
  let raw: string;
  try {
    raw = await readFile(statePath, 'utf8');
  } catch (error) {
    // Only a *missing* snapshot means a fresh target. Any other read failure
    // (permissions, I/O) must surface — treating it as empty would let a
    // subsequent apply silently overwrite the real snapshot.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { actual: [], lastApplied: [] };
    }
    throw new Error(
      `Failed to read state snapshot '${statePath}': ${error instanceof Error ? error.message : String(error)}`
    );
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StateSnapshot>;
    return { actual: parsed.actual ?? [], lastApplied: parsed.lastApplied ?? [] };
  } catch (error) {
    // A corrupt snapshot is never "fresh": refuse so the prior state is not
    // silently lost on the next apply.
    throw new Error(
      `State snapshot '${statePath}' is corrupt (not valid JSON): ${error instanceof Error ? error.message : String(error)}. Fix or remove the file before planning/applying.`
    );
  }
}

/**
 * A {@link StateProvider} backed by a JSON snapshot file. When `statePath` is
 * undefined the provider is read-only over an empty actual state (used by
 * `plan` with no `--state`): reads return empty and `setApplied` is a no-op.
 */
export function createFileStateProvider(statePath: string | undefined): StateProvider {
  return {
    async getActual(): Promise<readonly Resource[]> {
      if (statePath === undefined) {
        return [];
      }
      return (await readSnapshot(statePath)).actual;
    },
    async getLastApplied(): Promise<readonly Resource[]> {
      if (statePath === undefined) {
        return [];
      }
      return (await readSnapshot(statePath)).lastApplied;
    },
    async setApplied(desired: readonly Resource[], options?: SetAppliedOptions): Promise<void> {
      if (statePath === undefined) {
        return;
      }
      // A drift correction converges actual without rewriting the recorded
      // intent, so the snapshot keeps its previous lastApplied.
      const lastApplied =
        options?.preserveLastApplied === true
          ? (await readSnapshot(statePath)).lastApplied
          : desired;
      const snapshot: StateSnapshot = { actual: desired, lastApplied };
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath, JSON.stringify(snapshot, null, 2), 'utf8');
    },
  };
}
