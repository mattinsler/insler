import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FleetResult } from '@insler/platform/fleet';
import { expectTypeOf } from 'expect-type';

import { runGenerate } from './generate.js';
import type { GenerateArgs, GenerateIO } from './generate.js';

const FIXTURES = new URL('../../platform/src/fleet/__fixtures__/', import.meta.url).pathname;

function captureIO(): GenerateIO & { readonly outLines: string[]; readonly errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    out: (line: string) => outLines.push(line),
    err: (line: string) => errLines.push(line),
  };
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'insler-cli-gen-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- AC7: `insler generate` over a real fleet ---

describe('runGenerate (AC7)', () => {
  test('generates artifacts from a valid fleet into the output dir and exits 0', async () => {
    await withTmpDir(async (dir) => {
      const io = captureIO();
      const code = await runGenerate({ cwd: `${FIXTURES}valid`, outputDir: dir }, io);

      expect(code).toBe(0);
      expect(io.errLines).toEqual([]);
      const entries = await readdir(dir);
      expect(entries.length).toBeGreaterThan(0);
    });
  });

  test('--dry-run prints artifacts to stdout and writes nothing', async () => {
    await withTmpDir(async (dir) => {
      const io = captureIO();
      const code = await runGenerate({ cwd: `${FIXTURES}valid`, outputDir: dir, dryRun: true }, io);

      expect(code).toBe(0);
      expect(io.outLines.join('\n').length).toBeGreaterThan(0);
      const entries = await readdir(dir);
      expect(entries).toEqual([]);
    });
  });

  test('reports fleet errors with file locations and exits 1 (no generation)', async () => {
    await withTmpDir(async (dir) => {
      const io = captureIO();
      const code = await runGenerate({ cwd: `${FIXTURES}dup-name`, outputDir: dir }, io);

      expect(code).toBe(1);
      const errText = io.errLines.join('\n');
      expect(errText).toContain('duplicate-service-name');
      const entries = await readdir(dir);
      expect(entries).toEqual([]);
    });
  });

  test('the scan dependency is injectable for isolated unit testing', async () => {
    await withTmpDir(async (dir) => {
      const io = captureIO();
      const stub = async (): Promise<FleetResult> => ({
        manifest: { services: [], graph: { edges: [] }, expose: { routes: [] } },
        errors: [],
      });
      const code = await runGenerate({ outputDir: dir, dryRun: true }, io, stub);
      expect(code).toBe(0);
    });
  });
});

describe('runGenerate types', () => {
  test('argument and return signatures', () => {
    expectTypeOf(runGenerate).parameter(0).toEqualTypeOf<GenerateArgs>();
    expectTypeOf(runGenerate).parameter(1).toEqualTypeOf<GenerateIO>();
    expectTypeOf(runGenerate).returns.resolves.toEqualTypeOf<number>();
  });
});
