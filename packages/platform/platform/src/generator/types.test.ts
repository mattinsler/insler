import { describe, expect, test } from 'bun:test';

import { expectTypeOf } from 'expect-type';

import type { FleetManifest } from '../fleet/index.js';
import type { GeneratedFile, GeneratorOptions, GeneratorPlugin } from './types.js';

// --- AC1: the generator plugin interface is defined ---

describe('GeneratorPlugin contract (AC1)', () => {
  test('a plugin is a name plus a generate(manifest, options) => GeneratedFile[]', () => {
    expectTypeOf<GeneratorPlugin>().toHaveProperty('name');
    expectTypeOf<GeneratorPlugin['name']>().toEqualTypeOf<string>();

    expectTypeOf<GeneratorPlugin['generate']>().parameter(0).toEqualTypeOf<FleetManifest>();
    expectTypeOf<GeneratorPlugin['generate']>().parameter(1).toEqualTypeOf<GeneratorOptions>();
    expectTypeOf<GeneratorPlugin['generate']>().returns.toEqualTypeOf<readonly GeneratedFile[]>();
  });

  test('a concrete plugin literal satisfies the interface', () => {
    const plugin: GeneratorPlugin = {
      name: 'example',
      generate: () => [{ path: 'a.txt', content: 'a', format: 'text' }],
    };
    expect(plugin.name).toBe('example');
  });
});

describe('GeneratedFile contract (AC1, AC3)', () => {
  test('a generated file carries path, content, and a known format', () => {
    expectTypeOf<GeneratedFile['path']>().toEqualTypeOf<string>();
    expectTypeOf<GeneratedFile['content']>().toEqualTypeOf<string>();
    expectTypeOf<GeneratedFile['format']>().toEqualTypeOf<'yaml' | 'json' | 'toml' | 'text'>();
  });

  test('format rejects an unknown value', () => {
    // @ts-expect-error 'xml' is not a supported generated-file format
    const _bad: GeneratedFile = { path: 'a', content: 'b', format: 'xml' };
    expect(true).toBe(true);
  });
});

describe('GeneratorOptions contract (AC1)', () => {
  test('options carry target, outputDir, and environment', () => {
    expectTypeOf<GeneratorOptions['target']>().toEqualTypeOf<'kubernetes' | 'serverless'>();
    expectTypeOf<GeneratorOptions['outputDir']>().toEqualTypeOf<string>();
    expectTypeOf<GeneratorOptions['environment']>().toEqualTypeOf<string>();
  });

  test('target rejects an unknown deployment target', () => {
    const _bad: GeneratorOptions = {
      // @ts-expect-error 'mainframe' is not a supported target
      target: 'mainframe',
      outputDir: '/tmp/out',
      environment: 'prod',
    };
    expect(true).toBe(true);
  });
});
