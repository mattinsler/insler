import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expectTypeOf } from 'expect-type';

import { runApply } from './apply.js';
import type { ApplyArgs, ApplyIO } from './apply.js';

const FIXTURES = new URL('../../platform/src/fleet/__fixtures__/', import.meta.url).pathname;

function captureIO(): ApplyIO & { readonly outLines: string[]; readonly errLines: string[] } {
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
  const dir = await mkdtemp(join(tmpdir(), 'insler-cli-apply-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function stateFileExists(path: string): Promise<boolean> {
  return readFile(path, 'utf8').then(
    () => true,
    () => false
  );
}

// --- AC7: `insler apply` executes the plan ---

describe('runApply (AC7)', () => {
  test('applies a valid fleet, persists state, prints the plan, and exits 0', async () => {
    await withTmpDir(async (dir) => {
      const statePath = join(dir, 'state.json');
      const io = captureIO();
      const code = await runApply({ cwd: `${FIXTURES}valid`, statePath }, io);

      expect(code).toBe(0);
      expect(io.outLines.join('\n')).toContain('Plan:');
      expect(await stateFileExists(statePath)).toBe(true);
    });
  });

  test('applying twice converges — the second apply is a no-op', async () => {
    await withTmpDir(async (dir) => {
      const statePath = join(dir, 'state.json');
      await runApply({ cwd: `${FIXTURES}valid`, statePath }, captureIO());

      const io = captureIO();
      const code = await runApply({ cwd: `${FIXTURES}valid`, statePath }, io);
      expect(code).toBe(0);
      expect(io.outLines.join('\n')).toContain('No changes');
    });
  });

  // --- AC6: dry-run applies nothing ---

  test('--dry-run prints the plan but does not persist state (AC6)', async () => {
    await withTmpDir(async (dir) => {
      const statePath = join(dir, 'state.json');
      const io = captureIO();
      const code = await runApply({ cwd: `${FIXTURES}valid`, statePath, dryRun: true }, io);

      expect(code).toBe(0);
      expect(io.outLines.join('\n')).toContain('Plan:');
      expect(await stateFileExists(statePath)).toBe(false);
    });
  });

  test('reports fleet errors and exits 1 without applying', async () => {
    await withTmpDir(async (dir) => {
      const statePath = join(dir, 'state.json');
      const io = captureIO();
      const code = await runApply({ cwd: `${FIXTURES}dup-name`, statePath }, io);

      expect(code).toBe(1);
      expect(io.errLines.join('\n')).toContain('duplicate-service-name');
      expect(await stateFileExists(statePath)).toBe(false);
    });
  });
});

describe('runApply types', () => {
  test('argument and return signatures', () => {
    expectTypeOf(runApply).parameter(0).toEqualTypeOf<ApplyArgs>();
    expectTypeOf(runApply).parameter(1).toEqualTypeOf<ApplyIO>();
    expectTypeOf(runApply).returns.resolves.toEqualTypeOf<number>();
  });
});
