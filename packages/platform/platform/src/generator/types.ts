import type { FleetManifest } from '../fleet/index.js';

/**
 * `@insler/platform/generator` is the pluggable codegen engine: it turns a
 * {@link FleetManifest} (the desired-state model) into a set of physical
 * artifacts. The engine itself is artifact-agnostic — every concrete output
 * (K8s manifests #0012, KEDA #0013, edge routing #0014, secrets #0015, …) is a
 * {@link GeneratorPlugin} registered on the engine. This keeps the core small
 * and lets new output targets be added without touching the engine.
 *
 * Boundary: the generator depends only on the `FleetManifest` *model* from
 * `@insler/platform/fleet`, never on its filesystem scanner — a caller may bring its own
 * manifest (partial adoption), so the engine never reaches for the disk to
 * discover services.
 */

/** The deployment target a generation run is producing artifacts for. */
export type GeneratorTarget = 'kubernetes' | 'serverless';

/** The on-disk format of a generated artifact (drives how it is rendered). */
export type GeneratedFileFormat = 'yaml' | 'json' | 'toml' | 'text';

/**
 * A single artifact a plugin emits. `path` is relative to the run's
 * `outputDir`; `content` is the already-rendered text the engine writes
 * verbatim; `format` describes what that text is (so a downstream tool can pick
 * the right parser/linter without re-sniffing).
 */
export interface GeneratedFile {
  /** Output path, relative to {@link GeneratorOptions.outputDir}. */
  readonly path: string;
  /** The fully-rendered file body, written verbatim. */
  readonly content: string;
  /** The artifact's on-disk format. */
  readonly format: GeneratedFileFormat;
}

/**
 * Run-level options handed to every plugin. They describe *where* and *for what
 * environment* artifacts are being produced — not *what* to produce, which a
 * plugin derives from the manifest.
 */
export interface GeneratorOptions {
  /** The deployment target the run is producing for. */
  readonly target: GeneratorTarget;
  /** The directory generated files are rooted at. */
  readonly outputDir: string;
  /** The environment name (e.g. `dev`, `staging`, `prod`) the run targets. */
  readonly environment: string;
}

/**
 * The unit of extension. A plugin names itself and, given the fleet's
 * desired-state manifest plus the run options, returns the artifacts it owns.
 * `generate` must be pure and deterministic: the same manifest + options must
 * always yield the same files in the same order (the Notes' requirement, so
 * the file-level diff is meaningful). It does no I/O — the engine writes.
 */
export interface GeneratorPlugin {
  /** Unique name; two plugins may not share one on the same engine. */
  readonly name: string;
  /** Derive this plugin's artifacts from the manifest. Pure, no I/O. */
  generate(manifest: FleetManifest, options: GeneratorOptions): readonly GeneratedFile[];
}

/**
 * The outcome of a generation run: the complete, deterministically-ordered set
 * of artifacts every registered plugin produced.
 */
export interface GenerationResult {
  /** Every generated file, sorted by `path` for stable diffs. */
  readonly files: readonly GeneratedFile[];
}

/**
 * A file-level diff of one generation against a previous one (AC6). This is the
 * *generated-output* diff that feeds plan/diff — NOT the desired-vs-actual
 * reconciliation against running state (#0021). Each list holds paths, sorted.
 */
export interface GenerationDiff {
  /** Paths present now but not in the previous generation. */
  readonly added: readonly string[];
  /** Paths present in both, but with different content. */
  readonly changed: readonly string[];
  /** Paths present in the previous generation but not now. */
  readonly removed: readonly string[];
  /** Paths present in both with identical content. */
  readonly unchanged: readonly string[];
}

/**
 * The codegen engine. Plugins are registered with {@link Generator.use};
 * {@link Generator.generate} runs them all against a manifest and returns the
 * collected, deterministically-ordered {@link GenerationResult}. The result can
 * then be {@link Generator.write written} to disk, {@link Generator.dryRun
 * previewed} to a sink, or {@link Generator.diff diffed} against a prior run.
 */
export interface Generator {
  /** The names of every registered plugin, in registration order. */
  readonly plugins: readonly string[];
  /** Register one or more plugins; returns the same engine for chaining. */
  use(...plugins: readonly GeneratorPlugin[]): Generator;
  /** Run every plugin against the manifest and collect their artifacts. */
  generate(manifest: FleetManifest, options: GeneratorOptions): GenerationResult;
  /** Write a result's files under `outputDir`, creating nested directories. */
  write(result: GenerationResult, outputDir: string): Promise<void>;
  /** Preview a result by emitting each file to `sink` instead of writing. */
  dryRun(result: GenerationResult, sink: (line: string) => void): void;
  /** Classify `next` against `previous` at the file level (AC6). */
  diff(previous: readonly GeneratedFile[], next: readonly GeneratedFile[]): GenerationDiff;
}
