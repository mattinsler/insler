import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Contract } from '@insler/rpc/contract';
import { defineService } from '@insler/service';
import { expectTypeOf } from 'expect-type';
import { z } from 'zod';

import { buildFleetManifest } from '../fleet/index.js';
import type { FleetManifest } from '../fleet/index.js';
import { createGenerator } from './generator.js';
import type {
  GeneratedFile,
  GenerationDiff,
  GenerationResult,
  Generator as GeneratorEngine,
  GeneratorOptions,
  GeneratorPlugin,
} from './types.js';

// --- shared fixtures: a real FleetManifest built from the model only (no scanner) ---

function manifestOf(...names: readonly string[]): FleetManifest {
  const scanned = names.map((name) => ({
    service: defineService({
      name,
      kind: 'persistent',
      contract: Contract.create(name, {
        version: '1.0.0',
        methods: {
          run: { input: z.object({ x: z.string() }), output: z.object({ y: z.string() }) },
        },
      }),
    }),
    file: `/virtual/${name}.def.ts`,
  }));
  const result = buildFleetManifest(scanned);
  if (result.manifest === undefined) {
    throw new Error(`fixture manifest invalid: ${JSON.stringify(result.errors)}`);
  }
  return result.manifest;
}

const OPTIONS: GeneratorOptions = {
  target: 'kubernetes',
  outputDir: '/unused',
  environment: 'prod',
};

/** A plugin that emits one file per service, naming it after the service. */
function perServicePlugin(name: string): GeneratorPlugin {
  return {
    name,
    generate: (manifest) =>
      manifest.services.map((service) => ({
        path: `${name}/${service.name}.txt`,
        content: `service: ${service.name}\n`,
        format: 'text' as const,
      })),
  };
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'insler-gen-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- AC2 / AC3: the engine loads plugins and runs them against the manifest ---

describe('createGenerator — plugin registration & run (AC2, AC3)', () => {
  test('a registered plugin runs against the manifest and contributes its files', () => {
    const gen = createGenerator().use(perServicePlugin('k8s'));
    const result = gen.generate(manifestOf('orders'), OPTIONS);

    expect(result.files.map((f) => f.path)).toEqual(['k8s/orders.txt']);
  });

  test('multiple plugins each produce a set of files, all collected', () => {
    const gen = createGenerator().use(perServicePlugin('k8s'), perServicePlugin('keda'));
    const result = gen.generate(manifestOf('orders', 'checkout'), OPTIONS);

    expect(result.files.map((f) => f.path)).toEqual([
      'k8s/checkout.txt',
      'k8s/orders.txt',
      'keda/checkout.txt',
      'keda/orders.txt',
    ]);
  });

  test('each plugin receives the manifest and the options it was run with', () => {
    let seenTarget: string | undefined;
    const probe: GeneratorPlugin = {
      name: 'probe',
      generate: (manifest, options) => {
        seenTarget = options.target;
        return [{ path: `count-${manifest.services.length}.txt`, content: '', format: 'text' }];
      },
    };
    const result = createGenerator().use(probe).generate(manifestOf('a', 'b'), OPTIONS);

    expect(seenTarget).toBe('kubernetes');
    expect(result.files.map((f) => f.path)).toEqual(['count-2.txt']);
  });

  test('the set of registered plugin names is reported', () => {
    const gen = createGenerator().use(perServicePlugin('k8s'), perServicePlugin('keda'));
    expect(gen.plugins).toEqual(['k8s', 'keda']);
  });

  test('registering two plugins with the same name throws', () => {
    expect(() => createGenerator().use(perServicePlugin('dup'), perServicePlugin('dup'))).toThrow(
      /dup/
    );
  });
});

// --- Notes: deterministic output (sorted keys, stable ordering) ---

describe('deterministic output (Notes)', () => {
  test('files are returned in a stable, path-sorted order regardless of plugin/service order', () => {
    const a = createGenerator()
      .use(perServicePlugin('z'), perServicePlugin('a'))
      .generate(manifestOf('orders', 'checkout'), OPTIONS);
    const b = createGenerator()
      .use(perServicePlugin('z'), perServicePlugin('a'))
      .generate(manifestOf('checkout', 'orders'), OPTIONS);

    expect(a.files.map((f) => f.path)).toEqual(b.files.map((f) => f.path));
    const paths = a.files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
  });

  test('two plugins emitting the same path is an error (collision)', () => {
    const gen = createGenerator().use(
      { name: 'one', generate: () => [{ path: 'same.txt', content: 'x', format: 'text' }] },
      { name: 'two', generate: () => [{ path: 'same.txt', content: 'y', format: 'text' }] }
    );
    expect(() => gen.generate(manifestOf('orders'), OPTIONS)).toThrow(/same\.txt/);
  });
});

// --- AC4: the engine writes files to an output directory ---

describe('write — output directory (AC4)', () => {
  test('writes every generated file under outputDir, creating nested dirs', async () => {
    await withTmpDir(async (dir) => {
      const gen = createGenerator().use(perServicePlugin('k8s'));
      const result = gen.generate(manifestOf('orders'), { ...OPTIONS, outputDir: dir });
      await gen.write(result, dir);

      const written = await readFile(join(dir, 'k8s', 'orders.txt'), 'utf8');
      expect(written).toBe('service: orders\n');
    });
  });

  test('writes content exactly as produced', async () => {
    await withTmpDir(async (dir) => {
      const gen = createGenerator().use({
        name: 'json',
        generate: () => [{ path: 'a.json', content: '{"k":1}', format: 'json' }],
      });
      const result = gen.generate(manifestOf('orders'), { ...OPTIONS, outputDir: dir });
      await gen.write(result, dir);

      expect(await readFile(join(dir, 'a.json'), 'utf8')).toBe('{"k":1}');
    });
  });
});

// --- AC5: dry-run mode (output to stdout) ---

describe('dryRun — stdout sink (AC5)', () => {
  test('emits file contents to the sink and writes nothing to disk', async () => {
    await withTmpDir(async (dir) => {
      const lines: string[] = [];
      const gen = createGenerator().use(perServicePlugin('k8s'));
      const result = gen.generate(manifestOf('orders'), { ...OPTIONS, outputDir: dir });

      gen.dryRun(result, (line) => lines.push(line));

      const text = lines.join('\n');
      expect(text).toContain('k8s/orders.txt');
      expect(text).toContain('service: orders');
      // nothing written
      const entries = await readdir(dir);
      expect(entries).toEqual([]);
    });
  });
});

// --- AC6: reports what changed since last generation (file-level diff) ---

describe('diff — change report vs last generation (AC6)', () => {
  test('classifies added, changed, removed, and unchanged files', () => {
    const previous: readonly GeneratedFile[] = [
      { path: 'keep.txt', content: 'same', format: 'text' },
      { path: 'edit.txt', content: 'old', format: 'text' },
      { path: 'gone.txt', content: 'bye', format: 'text' },
    ];
    const next: readonly GeneratedFile[] = [
      { path: 'keep.txt', content: 'same', format: 'text' },
      { path: 'edit.txt', content: 'new', format: 'text' },
      { path: 'new.txt', content: 'hi', format: 'text' },
    ];

    const gen = createGenerator();
    const d: GenerationDiff = gen.diff(previous, next);

    expect(d.added).toEqual(['new.txt']);
    expect(d.changed).toEqual(['edit.txt']);
    expect(d.removed).toEqual(['gone.txt']);
    expect(d.unchanged).toEqual(['keep.txt']);
  });

  test('diff against an empty previous generation reports everything added', () => {
    const next: readonly GeneratedFile[] = [
      { path: 'b.txt', content: '2', format: 'text' },
      { path: 'a.txt', content: '1', format: 'text' },
    ];
    const d = createGenerator().diff([], next);
    expect(d.added).toEqual(['a.txt', 'b.txt']);
    expect(d.changed).toEqual([]);
    expect(d.removed).toEqual([]);
  });
});

// --- types ---

describe('generator types', () => {
  test('createGenerator returns a Generator; generate returns a GenerationResult', () => {
    expectTypeOf(createGenerator).returns.toEqualTypeOf<GeneratorEngine>();
    expectTypeOf<GeneratorEngine['generate']>().returns.toEqualTypeOf<GenerationResult>();
    // `.use` is chainable: it returns the engine itself.
    expectTypeOf<ReturnType<GeneratorEngine['use']>>().toEqualTypeOf<GeneratorEngine>();
  });
});
