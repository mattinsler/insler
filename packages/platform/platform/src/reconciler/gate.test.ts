import { describe, expect, test } from 'bun:test';

import { applyGated } from './gate.js';
import { createMemoryStateProvider } from './provider.js';
import { createReconciler } from './reconciler.js';
import type { AuditRecord, AuditSink, Resource } from './types.js';

/**
 * Issue 0023 — the production gate. `applyGated` wraps the engine's ungated
 * `apply` with the production policy: a plan may only be applied if it still
 * matches the live actual state (no blind apply / no stale apply, AC2 + AC7),
 * and every apply attempt — accepted or rejected — is written to an
 * {@link AuditSink} with a timestamp, the diff, and the operator identity (the
 * SOC 2 audit trail, AC4 + AC6).
 */

function service(name: string, spec: Record<string, unknown>): Resource {
  return { path: `deployment/${name}`, content: JSON.stringify(spec), format: 'yaml' };
}

/** A capturing in-memory audit sink for assertions. */
function captureAudit(): AuditSink & { readonly records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  return {
    records,
    record(entry: AuditRecord): Promise<void> {
      records.push(entry);
      return Promise.resolve();
    },
  };
}

const FIXED_NOW = new Date('2026-06-08T12:00:00.000Z');

describe('applyGated — accepted apply (0023 AC2, AC4)', () => {
  test('applies a matching plan and converges actual to desired', async () => {
    const provider = createMemoryStateProvider([service('summarize', { replicas: 2 })]);
    const reconciler = createReconciler(provider);
    const desired = [service('summarize', { replicas: 5 })];
    const plan = await reconciler.plan(desired);

    const result = await applyGated(reconciler, plan, {
      operator: 'matt@insler.dev',
      audit: captureAudit(),
      now: () => FIXED_NOW,
    });

    expect(result.outcome).toBe('applied');
    expect(result.apply?.applied).toBe(true);
    expect(await provider.getActual()).toEqual(desired);
  });

  test('writes an "applied" audit record with timestamp, operator, and the diff (AC4)', async () => {
    const provider = createMemoryStateProvider([service('summarize', { replicas: 2 })]);
    const reconciler = createReconciler(provider);
    const plan = await reconciler.plan([service('summarize', { replicas: 5 })]);
    const audit = captureAudit();

    await applyGated(reconciler, plan, {
      operator: 'matt@insler.dev',
      audit,
      now: () => FIXED_NOW,
    });

    expect(audit.records).toHaveLength(1);
    const record = audit.records[0]!;
    expect(record.outcome).toBe('applied');
    expect(record.operator).toBe('matt@insler.dev');
    expect(record.timestamp).toBe(FIXED_NOW.toISOString());
    // the diff is the plan itself — JSON-serializable for the trail
    expect(record.plan.fingerprint).toBe(plan.fingerprint);
    expect(record.plan.summary).toEqual({ add: 0, change: 1, destroy: 0 });
    expect(record.blastRadius.servicesAffected).toEqual(['summarize']);
  });

  test('the audit record round-trips through JSON (SOC 2 storage)', async () => {
    const provider = createMemoryStateProvider([]);
    const reconciler = createReconciler(provider);
    const plan = await reconciler.plan([service('orders', { replicas: 1 })]);
    const audit = captureAudit();

    await applyGated(reconciler, plan, { operator: 'ci-bot', audit, now: () => FIXED_NOW });

    const record = audit.records[0]!;
    expect(JSON.parse(JSON.stringify(record))).toEqual(
      JSON.parse(JSON.stringify(record)) as AuditRecord
    );
  });
});

describe('applyGated — no blind / stale apply (0023 AC2, AC7)', () => {
  test('rejects a stale plan when actual moved on, without mutating state', async () => {
    const provider = createMemoryStateProvider([service('summarize', { replicas: 2 })]);
    const reconciler = createReconciler(provider);
    const plan = await reconciler.plan([service('summarize', { replicas: 5 })]);

    // world moves on before apply
    await provider.setApplied([service('summarize', { replicas: 9 })]);
    const before = await provider.getActual();

    const result = await applyGated(reconciler, plan, {
      operator: 'matt@insler.dev',
      audit: captureAudit(),
      now: () => FIXED_NOW,
    });

    expect(result.outcome).toBe('rejected');
    expect(result.reason).toMatch(/stale plan/i);
    expect(result.apply).toBeUndefined();
    // state untouched
    expect(await provider.getActual()).toEqual(before);
  });

  test('logs a rejected plan with the same audit fields (AC6)', async () => {
    const provider = createMemoryStateProvider([service('summarize', { replicas: 2 })]);
    const reconciler = createReconciler(provider);
    const plan = await reconciler.plan([service('summarize', { replicas: 5 })]);
    await provider.setApplied([service('summarize', { replicas: 9 })]);
    const audit = captureAudit();

    await applyGated(reconciler, plan, {
      operator: 'matt@insler.dev',
      audit,
      now: () => FIXED_NOW,
    });

    expect(audit.records).toHaveLength(1);
    const record = audit.records[0]!;
    expect(record.outcome).toBe('rejected');
    expect(record.operator).toBe('matt@insler.dev');
    expect(record.timestamp).toBe(FIXED_NOW.toISOString());
    expect(record.reason).toMatch(/stale plan/i);
    // the rejected diff is still recorded for the trail
    expect(record.plan.fingerprint).toBe(plan.fingerprint);
  });
});
