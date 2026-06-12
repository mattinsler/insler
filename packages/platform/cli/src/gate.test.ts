import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FleetResult } from '@insler/platform/fleet';
import type { Resource, StateProvider } from '@insler/platform/reconciler';

import { runApply } from './apply.js';
import type { ApplyIO } from './apply.js';
import { runPlan } from './plan.js';

/**
 * Issue 0023 — the production plan gate, at the CLI seam. `insler plan
 * --env production` must emit a reviewable diff (and, with `--comment`, a CI PR
 * comment); `insler apply --env production` must refuse a stale plan, resolve an
 * operator identity, and write an append-only audit record for every attempt —
 * applied and rejected alike.
 */

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
  const dir = await mkdtemp(join(tmpdir(), 'insler-cli-gate-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readAudit(path: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// --- AC1: `insler plan --env production` shows a readable diff ---

describe('insler plan --env production (0023 AC1)', () => {
  test('prints an Atlas-style readable diff and exits 0', async () => {
    await withTmpDir(async (dir) => {
      const io = captureIO();
      const code = await runPlan(
        { cwd: `${FIXTURES}valid`, environment: 'production', statePath: join(dir, 'state.json') },
        io
      );
      expect(code).toBe(0);
      expect(io.outLines.join('\n')).toContain('Plan:');
    });
  });

  // --- AC5: plan output suitable for a CI PR comment ---

  test('--comment emits a Markdown CI comment with the blast radius (AC5)', async () => {
    await withTmpDir(async (dir) => {
      const io = captureIO();
      const code = await runPlan(
        {
          cwd: `${FIXTURES}valid`,
          environment: 'production',
          statePath: join(dir, 'state.json'),
          comment: true,
        },
        io
      );
      expect(code).toBe(0);
      const text = io.outLines.join('\n');
      expect(text).toContain('## insler plan');
      expect(text).toContain('resources changed');
    });
  });
});

// --- AC2 / AC4: gated apply writes an audit record with operator identity ---

describe('insler apply --env production (0023 AC2, AC4)', () => {
  test('applies a fresh plan, persists state, and logs an "applied" audit record', async () => {
    await withTmpDir(async (dir) => {
      const statePath = join(dir, 'state.json');
      const auditPath = join(dir, 'audit.jsonl');
      const io = captureIO();
      const code = await runApply(
        {
          cwd: `${FIXTURES}valid`,
          environment: 'production',
          statePath,
          auditPath,
          operator: 'matt@insler.dev',
        },
        io
      );

      expect(code).toBe(0);
      const records = await readAudit(auditPath);
      expect(records).toHaveLength(1);
      expect(records[0]!.outcome).toBe('applied');
      expect(records[0]!.operator).toBe('matt@insler.dev');
      expect(typeof records[0]!.timestamp).toBe('string');
    });
  });

  test('resolves operator identity from INSLER_OPERATOR when --operator is omitted', async () => {
    await withTmpDir(async (dir) => {
      const auditPath = join(dir, 'audit.jsonl');
      const io = captureIO();
      const prev = process.env.INSLER_OPERATOR;
      process.env.INSLER_OPERATOR = 'env-operator@insler.dev';
      try {
        await runApply(
          {
            cwd: `${FIXTURES}valid`,
            environment: 'production',
            statePath: join(dir, 'state.json'),
            auditPath,
          },
          io
        );
      } finally {
        if (prev === undefined) {
          delete process.env.INSLER_OPERATOR;
        } else {
          process.env.INSLER_OPERATOR = prev;
        }
      }
      const records = await readAudit(auditPath);
      expect(records[0]!.operator).toBe('env-operator@insler.dev');
    });
  });
});

// --- AC6 / AC7: a stale plan is rejected and the rejection is logged ---

describe('insler apply --env production — stale plan rejection (0023 AC6, AC7)', () => {
  test('refuses to apply when actual state changed since planning, and logs the rejection', async () => {
    await withTmpDir(async (dir) => {
      const auditPath = join(dir, 'audit.jsonl');

      // A provider whose actual state moves on between plan() and the apply-time
      // re-check: the first read (plan) sees the seeded state; the second read
      // (apply fingerprint recheck) sees a concurrently-mutated state. This is
      // exactly the production race the gate guards against (AC7).
      const provider = movingProvider([
        [
          {
            path: 'deployment/summarize',
            content: JSON.stringify({ replicas: 2 }),
            format: 'yaml',
          },
        ],
        [
          {
            path: 'deployment/summarize',
            content: JSON.stringify({ replicas: 9 }),
            format: 'yaml',
          },
        ],
      ]);

      const io = captureIO();
      const code = await runApply(
        { environment: 'production', auditPath, operator: 'matt@insler.dev' },
        io,
        emptyScan,
        () => provider
      );

      expect(code).toBe(1);
      expect(io.errLines.join('\n')).toMatch(/stale plan/i);
      const records = await readAudit(auditPath);
      expect(records).toHaveLength(1);
      expect(records[0]!.outcome).toBe('rejected');
      expect(records[0]!.reason).toMatch(/stale plan/i);
      expect(records[0]!.operator).toBe('matt@insler.dev');
    });
  });
});

/** A scan stub returning a single declared service so the plan is consequential. */
const emptyScan = async (): Promise<FleetResult> => ({
  manifest: { services: [], graph: { edges: [] }, expose: { routes: [] } },
  errors: [],
});

/**
 * A {@link StateProvider} whose `getActual` returns each seeded snapshot in turn,
 * modelling actual state changing out-of-band between the plan read and the
 * apply-time recheck. `setApplied` is a no-op (the apply must be rejected first).
 */
function movingProvider(snapshots: readonly (readonly Resource[])[]): StateProvider {
  let call = 0;
  return {
    getActual(): Promise<readonly Resource[]> {
      const snap = snapshots[Math.min(call, snapshots.length - 1)] ?? [];
      call += 1;
      return Promise.resolve(snap);
    },
    getLastApplied(): Promise<readonly Resource[]> {
      return Promise.resolve([]);
    },
    setApplied(): Promise<void> {
      return Promise.resolve();
    },
  };
}
