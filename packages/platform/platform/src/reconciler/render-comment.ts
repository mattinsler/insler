import { blastRadius } from './blast-radius.js';
import { renderPlan } from './render.js';
import type { Plan } from './types.js';

/**
 * Render a {@link Plan} as a Markdown block suitable for a CI pull-request
 * comment (issue 0023 AC5): a heading, a one-line blast-radius summary (services
 * affected + resources changed), and the Atlas-style diff inside a fenced
 * `diff` block so reviewers see the change scope at a glance on the PR. Pure and
 * deterministic — equal plans render byte-identical comments, so re-running plan
 * in CI updates the comment idempotently.
 */
export function renderPlanComment(plan: Plan): string {
  const radius = blastRadius(plan);
  const services = radius.servicesAffected.length > 0 ? radius.servicesAffected.join(', ') : 'none';

  const lines: string[] = [
    '## insler plan',
    '',
    `**Blast radius:** ${radius.resourcesChanged} resources changed across services: ${services}`,
    '',
    `Plan: ${plan.summary.add} to add, ${plan.summary.change} to change, ${plan.summary.destroy} to destroy`,
    '',
    '```diff',
    renderPlan(plan),
    '```',
  ];

  return lines.join('\n');
}
