import { describe, expect, test } from 'bun:test';

import { diffState } from './diff.js';
import { renderPlan } from './render.js';
import type { Resource } from './types.js';

function r(path: string, content: string): Resource {
  return { path, content, format: 'yaml' };
}

// --- AC2: produces a human-readable plan showing adds, changes, and destroys ---

describe('renderPlan (AC2)', () => {
  test('leads with an Atlas-style summary line of the counts', () => {
    const plan = diffState(
      [r('add-me', 'a'), r('change-me', 'new'), r('keep-me', 'k')],
      [r('change-me', 'old'), r('keep-me', 'k'), r('destroy-me', 'd')]
    );
    const text = renderPlan(plan);
    expect(text.split('\n')[0]).toBe('Plan: 1 to add, 1 to change, 1 to destroy');
  });

  test('marks an add with a + and the path', () => {
    const text = renderPlan(diffState([r('deployment/summarize', 'v1')], []));
    expect(text).toContain('+ deployment/summarize');
  });

  test('marks a change with a ~ and the path', () => {
    const text = renderPlan(
      diffState([r('deployment/session-hub', 'b')], [r('deployment/session-hub', 'a')])
    );
    expect(text).toContain('~ deployment/session-hub');
  });

  test('marks a destroy with a - and the path', () => {
    const text = renderPlan(diffState([], [r('deployment/legacy', 'old')]));
    expect(text).toContain('- deployment/legacy');
  });

  test('lists converged resources under a "No changes" line', () => {
    const text = renderPlan(
      diffState([r('deployment/orders', 'same')], [r('deployment/orders', 'same')])
    );
    expect(text).toContain('No changes:');
    expect(text).toContain('deployment/orders');
  });

  // --- AC3: a no-op plan renders an explicit "no changes" verdict ---

  test('a converged (no-op) plan renders a clear no-changes verdict', () => {
    const text = renderPlan(diffState([r('a', '1')], [r('a', '1')]));
    expect(text).toContain('No changes');
    expect(text).not.toContain('+ ');
    expect(text).not.toContain('~ ');
  });

  test('does not list no-op resources among the consequential changes', () => {
    const plan = diffState([r('add-me', 'a'), r('keep-me', 'k')], [r('keep-me', 'k')]);
    const text = renderPlan(plan);
    const addSection = text.split('No changes:')[0] ?? '';
    expect(addSection).not.toContain('keep-me');
  });
});
