import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { FleetManifest } from '../fleet/index.js';
import type {
  GeneratedFile,
  GenerationDiff,
  GenerationResult,
  Generator,
  GeneratorOptions,
  GeneratorPlugin,
} from './types.js';

/** Sort files by path so a run's output (and its diff) is stable. */
function sortByPath(files: readonly GeneratedFile[]): GeneratedFile[] {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Run every plugin against the manifest, collect their files, and fail loudly
 * on a path collision — two artifacts targeting the same path would otherwise
 * silently clobber each other and make the diff meaningless.
 */
function collect(
  plugins: readonly GeneratorPlugin[],
  manifest: FleetManifest,
  options: GeneratorOptions
): GeneratedFile[] {
  const byPath = new Map<string, string>();
  const files: GeneratedFile[] = [];

  for (const plugin of plugins) {
    for (const file of plugin.generate(manifest, options)) {
      const owner = byPath.get(file.path);
      if (owner !== undefined) {
        throw new Error(
          `generator: path collision on '${file.path}' (emitted by both '${owner}' and '${plugin.name}')`
        );
      }
      byPath.set(file.path, plugin.name);
      files.push(file);
    }
  }

  return sortByPath(files);
}

class GeneratorImpl implements Generator {
  readonly #plugins: GeneratorPlugin[] = [];

  get plugins(): readonly string[] {
    return this.#plugins.map((p) => p.name);
  }

  use(...plugins: readonly GeneratorPlugin[]): Generator {
    for (const plugin of plugins) {
      if (this.#plugins.some((existing) => existing.name === plugin.name)) {
        throw new Error(`generator: a plugin named '${plugin.name}' is already registered`);
      }
      this.#plugins.push(plugin);
    }
    return this;
  }

  generate(manifest: FleetManifest, options: GeneratorOptions): GenerationResult {
    return { files: collect(this.#plugins, manifest, options) };
  }

  async write(result: GenerationResult, outputDir: string): Promise<void> {
    for (const file of result.files) {
      const dest = join(outputDir, file.path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, file.content, 'utf8');
    }
  }

  dryRun(result: GenerationResult, sink: (line: string) => void): void {
    for (const file of result.files) {
      sink(`# ${file.path} (${file.format})`);
      sink(file.content);
    }
  }

  diff(previous: readonly GeneratedFile[], next: readonly GeneratedFile[]): GenerationDiff {
    const prev = new Map(previous.map((f) => [f.path, f.content]));
    const curr = new Map(next.map((f) => [f.path, f.content]));

    const added: string[] = [];
    const changed: string[] = [];
    const unchanged: string[] = [];
    const removed: string[] = [];

    for (const [path, content] of curr) {
      const before = prev.get(path);
      if (before === undefined) {
        added.push(path);
      } else if (before === content) {
        unchanged.push(path);
      } else {
        changed.push(path);
      }
    }
    for (const path of prev.keys()) {
      if (!curr.has(path)) {
        removed.push(path);
      }
    }

    const sort = (xs: string[]): string[] => xs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return {
      added: sort(added),
      changed: sort(changed),
      removed: sort(removed),
      unchanged: sort(unchanged),
    };
  }
}

/**
 * Create an empty codegen engine. Register artifact plugins with `.use(...)`,
 * then call `.generate(manifest, options)` to produce the deterministic
 * artifact set. The engine owns orchestration, ordering, collision detection,
 * writing, dry-run preview, and file-level diffing; the plugins own what each
 * artifact looks like.
 */
export function createGenerator(): Generator {
  return new GeneratorImpl();
}
