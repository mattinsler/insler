import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileStateProvider } from './reconcile-shared.js';

/**
 * Snapshot-file semantics of the CLI's {@link createFileStateProvider}. The
 * critical rule (issue 0021 follow-up): only a *missing* snapshot is a fresh,
 * empty target. A corrupt or unreadable snapshot must surface as an error —
 * never read as empty and then silently overwritten by the next apply.
 */

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'insler-state-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('createFileStateProvider — snapshot read semantics', () => {
  test('a missing snapshot file is a fresh, empty target', async () => {
    await withTmpDir(async (dir) => {
      const provider = createFileStateProvider(join(dir, 'does-not-exist.json'));
      expect(await provider.getActual()).toEqual([]);
      expect(await provider.getLastApplied()).toEqual([]);
    });
  });

  test('a corrupt (non-JSON) snapshot rejects instead of reading as empty', async () => {
    await withTmpDir(async (dir) => {
      const statePath = join(dir, 'state.json');
      await writeFile(statePath, '{ not json !!!', 'utf8');
      const provider = createFileStateProvider(statePath);
      await expect(provider.getActual()).rejects.toThrow(/corrupt/);
      await expect(provider.getLastApplied()).rejects.toThrow(statePath);
    });
  });

  test('a corrupt snapshot is never overwritten by a drift-preserving apply', async () => {
    await withTmpDir(async (dir) => {
      const statePath = join(dir, 'state.json');
      const corrupt = '{ not json !!!';
      await writeFile(statePath, corrupt, 'utf8');
      const provider = createFileStateProvider(statePath);
      // preserveLastApplied re-reads the snapshot; the corrupt read must throw
      // before anything is written back.
      await expect(
        provider.setApplied([{ path: 'a.yaml', content: 'x', format: 'yaml' }], {
          preserveLastApplied: true,
        })
      ).rejects.toThrow(/corrupt/);
      expect(await readFile(statePath, 'utf8')).toBe(corrupt);
    });
  });

  test('an unreadable snapshot (permissions) rejects rather than reading as empty', async () => {
    // chmod-based denial does not apply when running as root (root reads anything).
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return;
    }
    await withTmpDir(async (dir) => {
      const statePath = join(dir, 'state.json');
      await writeFile(statePath, JSON.stringify({ actual: [], lastApplied: [] }), 'utf8');
      await chmod(statePath, 0o000);
      const provider = createFileStateProvider(statePath);
      await expect(provider.getActual()).rejects.toThrow(/Failed to read/);
      await chmod(statePath, 0o644);
    });
  });

  test('a valid snapshot round-trips through setApplied and getActual', async () => {
    await withTmpDir(async (dir) => {
      const statePath = join(dir, 'state.json');
      const provider = createFileStateProvider(statePath);
      const desired = [{ path: 'a.yaml', content: 'x', format: 'yaml' as const }];
      await provider.setApplied(desired);
      expect(await provider.getActual()).toEqual(desired);
      expect(await provider.getLastApplied()).toEqual(desired);
    });
  });
});
