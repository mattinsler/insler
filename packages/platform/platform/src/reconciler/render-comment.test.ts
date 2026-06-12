import { describe, expect, test } from 'bun:test';

import { diffState } from './diff.js';
import { renderPlanComment } from './render-comment.js';
import type { Resource } from './types.js';

/**
 * AC5 (issue 0023): the plan output must be suitable for a CI PR comment — a
 * self-contained Markdown block carrying the blast-radius summary and the diff,
 * deterministic so re-running the same plan yields byte-identical comment text.
 */

function r(path: string, content: string): Resource {
  return { path, content, format: 'yaml' };
}

describe('renderPlanComment (0023 AC5)', () => {
  test('renders a Markdown heading and a blast-radius summary', () => {
    const plan = diffState(
      [r('deployment/payments', 'new'), r('deployment/summarize', 'v2')],
      [r('deployment/summarize', 'v1'), r('deployment/legacy', 'old')]
    );
    const md = renderPlanComment(plan);

    expect(md).toContain('## insler plan');
    // blast radius: resources changed + services affected
    expect(md).toContain('3 resources changed');
    expect(md).toMatch(/legacy.*payments.*summarize/s);
  });

  test('embeds the diff inside a fenced code block for PR readability', () => {
    const plan = diffState([r('deployment/summarize', 'v2')], [r('deployment/summarize', 'v1')]);
    const md = renderPlanComment(plan);
    expect(md).toContain('```diff');
    expect(md).toContain('~ deployment/summarize');
  });

  test('a converged plan renders a clear no-changes comment', () => {
    const plan = diffState([r('deployment/orders', 'same')], [r('deployment/orders', 'same')]);
    const md = renderPlanComment(plan);
    expect(md).toContain('No changes');
    expect(md).toContain('0 resources changed');
  });

  test('is deterministic — equal plans render identical comment text', () => {
    const desired = [r('deployment/a', 'x'), r('deployment/b', 'y')];
    const actual = [r('deployment/a', 'old')];
    expect(renderPlanComment(diffState(desired, actual))).toBe(
      renderPlanComment(diffState(desired, actual))
    );
  });
});
