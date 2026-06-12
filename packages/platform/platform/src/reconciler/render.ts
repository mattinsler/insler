import type { Plan } from './types.js';

/**
 * Render a {@link Plan} as a human-readable, Atlas-style report (AC2): a summary
 * line of the counts, then `+`/`~`/`-` lines for the consequential changes, then
 * a trailing `No changes:` line listing the converged resources. A fully
 * converged plan renders an explicit no-changes verdict (AC3). Pure formatting —
 * no I/O, no color codes — so it is stable to assert on and pipe anywhere.
 */
export function renderPlan(plan: Plan): string {
  const { add, change, destroy } = plan.summary;
  const lines: string[] = [`Plan: ${add} to add, ${change} to change, ${destroy} to destroy`];

  const adds = plan.changes.filter((c) => c.action === 'add');
  const changed = plan.changes.filter((c) => c.action === 'change');
  const destroys = plan.changes.filter((c) => c.action === 'destroy');
  const noops = plan.changes.filter((c) => c.action === 'no-op');

  if (adds.length + changed.length + destroys.length > 0) {
    lines.push('');
    for (const c of adds) {
      lines.push(`+ ${c.path} (new)`);
    }
    for (const c of changed) {
      lines.push(`~ ${c.path} (changed)`);
    }
    for (const c of destroys) {
      lines.push(`- ${c.path} (destroy)`);
    }
  }

  if (noops.length > 0) {
    lines.push('');
    lines.push(`No changes: ${noops.map((c) => c.path).join(', ')}`);
  } else if (plan.isNoOp) {
    lines.push('');
    lines.push('No changes. Desired and actual state are converged.');
  }

  return lines.join('\n');
}
