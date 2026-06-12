import { watch as fsWatch } from 'node:fs';

import { scanFleet } from '@insler/platform/fleet';
import { applyAuto, createReconciler } from '@insler/platform/reconciler';
import type { PlanSummary } from '@insler/platform/reconciler';

import type { StateProviderFactory } from './plan.js';
import { createFileStateProvider, deriveDesiredState, PRODUCTION_ENV } from './reconcile-shared.js';
import type { ReconcileIO } from './reconcile-shared.js';

/**
 * The `insler dev` command (issue 0022) — development auto-convergence. This is
 * the composition layer that wires `@insler/platform/fleet` (scanner) + `@insler/platform/generator`
 * + `@insler/platform/reconciler` into the dev inner loop: watch the `defineService`
 * declaration files, and on every change re-scan, re-generate, diff against the
 * current state, and AUTO-APPLY the result through the ungated {@link applyAuto}
 * primitive — no plan review, no approval. Saving a declaration applies it.
 *
 * This speed path is **development-only**. `--env production` is refused outright
 * (the production change story is the gated `insler apply`, issue 0023); the
 * watcher never starts and nothing is applied.
 *
 * The orchestration deliberately lives here, not in the reconciler: the engine
 * stays scanner-free. Kept seam-injectable (scan, state-provider factory, and
 * the file-watch source) so the converge cycle and the watcher trigger are both
 * testable hermetically — no reliance on real, flaky watch timing.
 */

/** Where the command writes its output and diagnostics. */
export type DevIO = ReconcileIO;

/** Parsed `insler dev` arguments. */
export interface DevArgs {
  /** Directory to scan/watch for service declarations (defaults to cwd). */
  readonly cwd?: string;
  /** Environment name passed to the generator (defaults to `dev`). Never `production`. */
  readonly environment?: string;
  /** Path to the actual-state JSON snapshot (in-memory/empty when omitted). */
  readonly statePath?: string;
}

/** The outcome of a single auto-converge cycle (scan → generate → diff → apply). */
export interface ConvergeReport {
  /** True when the cycle completed (scan valid + apply attempted). */
  readonly ok: boolean;
  /** True when state was mutated this cycle (false for a no-op/converged plan). */
  readonly applied?: boolean;
  /** Counts of the consequential actions applied; absent on a failed scan. */
  readonly summary?: PlanSummary;
}

/** A live file watch; `close()` tears it down. Mirrors `fs.FSWatcher`'s shape. */
export interface WatchHandle {
  /** Stop watching and release the underlying resource. */
  close(): void;
}

/**
 * The file-watch seam. Given a directory and a change handler, begin watching
 * and return a {@link WatchHandle}. The default implementation uses Node/Bun's
 * recursive `fs.watch`; tests inject a deterministic fake so a "change" is a
 * direct call, not a timing-dependent OS event.
 */
export type WatchSource = (dir: string, onChange: () => void) => WatchHandle;

/** A running `insler dev` session: the watcher plus lifecycle controls. */
export interface DevSession {
  /** Exit code of the *initial* converge (0 ok / scan failure surfaces as the converge report). */
  readonly code: number;
  /** Stop the watcher and end the session. */
  stop(): void;
  /** Resolve once all in-flight converge cycles have settled (test determinism). */
  idle(): Promise<void>;
}

/** Injectable dependencies for {@link runDev} (all default to the real impls). */
export interface DevDeps {
  /** Builds the {@link StateProvider} the loop reconciles against. */
  readonly makeProvider?: StateProviderFactory;
  /** The file-watch source (defaults to recursive `fs.watch`). */
  readonly watch?: WatchSource;
  /** The fleet scanner (injectable for tests). */
  readonly scan?: typeof scanFleet;
}

/** Service-declaration file suffixes — the fleet scanner's discovery convention. */
const DECLARATION_SUFFIXES = ['.service.ts', '.def.ts'] as const;

function isDeclarationFile(filename: string | null): boolean {
  return filename !== null && DECLARATION_SUFFIXES.some((suffix) => filename.endsWith(suffix));
}

/** The default {@link WatchSource}: a recursive `fs.watch`, declaration-filtered. */
function defaultWatch(dir: string, onChange: () => void): WatchHandle {
  const watcher = fsWatch(dir, { recursive: true }, (_event, filename) => {
    // Only declaration files matter; ignore generated artifacts and noise.
    if (isDeclarationFile(typeof filename === 'string' ? filename : null)) {
      onChange();
    }
  });
  return { close: () => watcher.close() };
}

/**
 * Run one auto-converge cycle: scan `cwd` into a fleet manifest, derive the
 * desired-state artifacts via the generator, diff against the current state, and
 * auto-apply (ungated). Reports what changed to `io`. A failed scan is reported
 * and returns `ok: false` — it never throws, so the watch loop survives a
 * malformed declaration and recovers on the next save.
 */
export async function converge(
  args: DevArgs,
  io: DevIO,
  makeProvider: StateProviderFactory = createFileStateProvider,
  scan: typeof scanFleet = scanFleet
): Promise<ConvergeReport> {
  let derived: Awaited<ReturnType<typeof deriveDesiredState>>;
  try {
    derived = await deriveDesiredState(args.cwd, args.environment, io, scan);
  } catch (error) {
    // A declaration that fails to import/parse (mid-edit syntax error, missing
    // dependency) throws out of the scanner. In the watch loop that must not be
    // fatal — report it and let the next save recover.
    const reason = error instanceof Error ? error.message : String(error);
    io.err(`Converge failed: ${reason}`);
    return { ok: false };
  }
  if (derived.desired === undefined) {
    // deriveDesiredState already reported the scan errors on io.err.
    return { ok: false };
  }

  const reconciler = createReconciler(makeProvider(args.statePath));
  let result: Awaited<ReturnType<typeof applyAuto>>;
  try {
    const plan = await reconciler.plan(derived.desired);
    result = await applyAuto(reconciler, plan);
  } catch (error) {
    // e.g. a corrupt --state snapshot: the watch loop must survive, and the
    // snapshot must never be overwritten while unreadable.
    const reason = error instanceof Error ? error.message : String(error);
    io.err(`Converge failed: ${reason}`);
    return { ok: false };
  }

  if (result.applied) {
    const { add, change, destroy } = result.summary;
    io.out(`Converged: ${add} added, ${change} changed, ${destroy} destroyed.`);
  } else {
    io.out('Up to date: no changes to apply.');
  }
  return { ok: true, applied: result.applied, summary: result.summary };
}

/**
 * Watch a directory's service-declaration files and invoke `onChange` on every
 * relevant change. Thin wrapper over the {@link WatchSource} seam so the trigger
 * is testable without real OS watch events.
 */
export function watchDeclarations(
  dir: string,
  onChange: () => void,
  watch: WatchSource = defaultWatch
): WatchHandle {
  return watch(dir, onChange);
}

/**
 * Run `insler dev`: guard against production, perform an initial converge, then
 * watch the declaration files and re-converge on every change. Returns a
 * {@link DevSession} (the initial converge's exit code, plus `stop`/`idle`)
 * rather than blocking, so the binary can keep the process alive and tests can
 * drive it deterministically. Refuses `--env production` with exit code 1 and
 * never starts the watcher.
 */
export async function runDev(args: DevArgs, io: DevIO, deps: DevDeps = {}): Promise<DevSession> {
  if (args.environment === PRODUCTION_ENV) {
    io.err(
      'insler dev auto-converges without review and is development-only; it refuses --env production. Use `insler apply --env production` (gated) for production changes.'
    );
    return {
      code: 1,
      stop: () => undefined,
      idle: () => Promise.resolve(),
    };
  }

  const makeProvider = deps.makeProvider ?? createFileStateProvider;
  const scan = deps.scan ?? scanFleet;
  const watch = deps.watch ?? defaultWatch;
  const dir = args.cwd ?? process.cwd();

  // Initial convergence so a fresh `insler dev` immediately reflects the code.
  const initial = await converge(args, io, makeProvider, scan);

  // Serialize and coalesce cycles: changes never race concurrent applies, and a
  // burst of saves collapses onto at most ONE follow-up converge (the cycle that
  // starts after the burst sees all of it) instead of one redundant cycle per
  // FS event. `idle()` awaits the tail.
  let pending: Promise<unknown> = Promise.resolve();
  let queued = false;
  const enqueue = (): void => {
    if (queued) {
      return;
    }
    queued = true;
    pending = pending.then(() => {
      // Un-mark before scanning so a change landing mid-cycle queues one more.
      queued = false;
      return converge(args, io, makeProvider, scan);
    });
  };

  const handle = watchDeclarations(dir, enqueue, watch);

  return {
    code: initial.ok ? 0 : 1,
    stop: () => handle.close(),
    idle: () => pending.then(() => undefined),
  };
}
