import { describe, expect, test } from 'bun:test';

import type { GeneratedFile } from '../generator/index.js';
import { diffState, toResources } from './diff.js';
import type { Resource } from './types.js';

function r(path: string, content: string): Resource {
  return { path, content, format: 'yaml' };
}

// --- AC1: engine computes the diff between desired and actual state ---

describe('diffState (AC1)', () => {
  test('classifies a resource present only in desired as an add', () => {
    const plan = diffState([r('deployment/summarize', 'v1')], []);
    expect(plan.summary).toEqual({ add: 1, change: 0, destroy: 0 });
    expect(plan.changes).toEqual([
      { action: 'add', path: 'deployment/summarize', format: 'yaml', after: 'v1' },
    ]);
  });

  test('classifies a resource present in both with different content as a change', () => {
    const plan = diffState(
      [r('deployment/session-hub', 'replicas:4')],
      [r('deployment/session-hub', 'replicas:2')]
    );
    expect(plan.summary).toEqual({ add: 0, change: 1, destroy: 0 });
    expect(plan.changes).toEqual([
      {
        action: 'change',
        path: 'deployment/session-hub',
        format: 'yaml',
        before: 'replicas:2',
        after: 'replicas:4',
      },
    ]);
  });

  test('classifies a resource present only in actual as a destroy', () => {
    const plan = diffState([], [r('deployment/legacy', 'old')]);
    expect(plan.summary).toEqual({ add: 0, change: 0, destroy: 1 });
    expect(plan.changes).toEqual([
      { action: 'destroy', path: 'deployment/legacy', format: 'yaml', before: 'old' },
    ]);
  });

  test('classifies a resource identical on both sides as a no-op', () => {
    const plan = diffState([r('deployment/orders', 'same')], [r('deployment/orders', 'same')]);
    expect(plan.summary).toEqual({ add: 0, change: 0, destroy: 0 });
    expect(plan.changes).toEqual([
      { action: 'no-op', path: 'deployment/orders', format: 'yaml', before: 'same', after: 'same' },
    ]);
  });

  test('computes a mixed changeset across all four actions at once', () => {
    const desired = [r('add-me', 'a'), r('change-me', 'new'), r('keep-me', 'k')];
    const actual = [r('change-me', 'old'), r('keep-me', 'k'), r('destroy-me', 'd')];
    const plan = diffState(desired, actual);
    expect(plan.summary).toEqual({ add: 1, change: 1, destroy: 1 });
    expect(plan.changes.map((c) => `${c.action}:${c.path}`)).toEqual([
      'add:add-me',
      'change:change-me',
      'destroy:destroy-me',
      'no-op:keep-me',
    ]);
  });

  // --- AC3: no-op when converged ---

  test('is a no-op when desired and actual are fully converged', () => {
    const state = [r('a', '1'), r('b', '2')];
    const plan = diffState(state, state);
    expect(plan.isNoOp).toBe(true);
    expect(plan.summary).toEqual({ add: 0, change: 0, destroy: 0 });
  });

  test('two empty states are a no-op', () => {
    const plan = diffState([], []);
    expect(plan.isNoOp).toBe(true);
    expect(plan.changes).toEqual([]);
  });

  test('any consequential change makes the plan not a no-op', () => {
    expect(diffState([r('a', '1')], []).isNoOp).toBe(false);
  });

  // determinism: stable, path-sorted output regardless of input order
  test('produces deterministic path-sorted output regardless of input order', () => {
    const a = diffState([r('z', '1'), r('a', '1')], []);
    const b = diffState([r('a', '1'), r('z', '1')], []);
    expect(a).toEqual(b);
    expect(a.changes.map((c) => c.path)).toEqual(['a', 'z']);
  });

  // --- AC5: plan is serializable for audit logging ---

  test('the plan round-trips losslessly through JSON for audit logging (AC5)', () => {
    const plan = diffState([r('add-me', 'a'), r('change-me', 'new')], [r('change-me', 'old')]);
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });
});

// --- bridging the generator's desired-state output into resources ---

describe('toResources', () => {
  test('maps generator GeneratedFile[] to reconciler Resource[]', () => {
    const files: GeneratedFile[] = [
      { path: 'a.yaml', content: 'x', format: 'yaml' },
      { path: 'b.json', content: 'y', format: 'json' },
    ];
    expect(toResources(files)).toEqual([
      { path: 'a.yaml', content: 'x', format: 'yaml' },
      { path: 'b.json', content: 'y', format: 'json' },
    ]);
  });

  test('a generated artifact set diffs directly as desired state', () => {
    const files: GeneratedFile[] = [
      { path: 'deployment/summarize', content: 'v1', format: 'yaml' },
    ];
    const plan = diffState(toResources(files), []);
    expect(plan.summary.add).toBe(1);
  });
});
