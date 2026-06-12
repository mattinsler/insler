import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FleetResult } from '@insler/platform/fleet';
import { expectTypeOf } from 'expect-type';

import { runApply } from './apply.js';
import { runPlan } from './plan.js';
import type { PlanArgs, PlanIO } from './plan.js';

const FIXTURES = new URL('../../platform/src/fleet/__fixtures__/', import.meta.url).pathname;

function captureIO(): PlanIO & { readonly outLines: string[]; readonly errLines: string[] } {
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
  const dir = await mkdtemp(join(tmpdir(), 'insler-cli-plan-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- AC7: `insler plan` shows the diff ---

describe('runPlan (AC7)', () => {
  test('prints an Atlas-style plan from a valid fleet and exits 0', async () => {
    await withTmpDir(async (dir) => {
      const io = captureIO();
      const code = await runPlan(
        { cwd: `${FIXTURES}valid`, statePath: join(dir, 'state.json') },
        io
      );

      expect(code).toBe(0);
      const text = io.outLines.join('\n');
      expect(text).toContain('Plan:');
      // first plan against empty actual state -> everything is an add
      expect(text).toContain('to add');
    });
  });

  test('reports fleet errors with file locations and exits 1 (no plan)', async () => {
    await withTmpDir(async (dir) => {
      const io = captureIO();
      const code = await runPlan(
        { cwd: `${FIXTURES}dup-name`, statePath: join(dir, 'state.json') },
        io
      );

      expect(code).toBe(1);
      expect(io.errLines.join('\n')).toContain('duplicate-service-name');
    });
  });

  test('after apply, planning the same fleet is a no-op (converged)', async () => {
    await withTmpDir(async (dir) => {
      const statePath = join(dir, 'state.json');
      await runApply({ cwd: `${FIXTURES}valid`, statePath }, captureIO());

      const io = captureIO();
      const code = await runPlan({ cwd: `${FIXTURES}valid`, statePath }, io);
      expect(code).toBe(0);
      expect(io.outLines.join('\n')).toContain('No changes');
    });
  });

  test('a corrupt --state snapshot is reported and exits 1 — never planned as empty', async () => {
    await withTmpDir(async (dir) => {
      const statePath = join(dir, 'state.json');
      await Bun.write(statePath, '{ not json !!!');
      const io = captureIO();
      const code = await runPlan({ cwd: `${FIXTURES}valid`, statePath }, io);
      expect(code).toBe(1);
      expect(io.errLines.join('\n')).toContain('corrupt');
    });
  });

  test('apply refuses a corrupt --state snapshot and leaves the file untouched', async () => {
    await withTmpDir(async (dir) => {
      const statePath = join(dir, 'state.json');
      const corrupt = '{ not json !!!';
      await Bun.write(statePath, corrupt);
      const io = captureIO();
      const code = await runApply({ cwd: `${FIXTURES}valid`, statePath }, io);
      expect(code).toBe(1);
      expect(io.errLines.join('\n')).toContain('corrupt');
      expect(await Bun.file(statePath).text()).toBe(corrupt);
    });
  });

  test('the scan dependency is injectable for isolated unit testing', async () => {
    await withTmpDir(async (dir) => {
      const io = captureIO();
      const stub = async (): Promise<FleetResult> => ({
        manifest: { services: [], graph: { edges: [] }, expose: { routes: [] } },
        errors: [],
      });
      const code = await runPlan({ statePath: join(dir, 'state.json') }, io, stub);
      expect(code).toBe(0);
    });
  });
});

describe('runPlan types', () => {
  test('argument and return signatures', () => {
    expectTypeOf(runPlan).parameter(0).toEqualTypeOf<PlanArgs>();
    expectTypeOf(runPlan).parameter(1).toEqualTypeOf<PlanIO>();
    expectTypeOf(runPlan).returns.resolves.toEqualTypeOf<number>();
  });
});
