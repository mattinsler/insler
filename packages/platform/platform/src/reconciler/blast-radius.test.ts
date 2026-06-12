import { describe, expect, test } from 'bun:test';

import { blastRadius } from './blast-radius.js';
import { diffState } from './diff.js';
import type { Resource } from './types.js';

/**
 * AC3 (issue 0023): a plan includes a blast-radius summary — the services
 * affected and the count of resources changed — so an operator can review the
 * scope of a production change before applying it.
 */

function r(path: string, content: string): Resource {
  return { path, content, format: 'yaml' };
}

describe('blastRadius (0023 AC3)', () => {
  test('reports the count of consequential resources changed (excludes no-ops)', () => {
    const plan = diffState(
      [r('deployment/a', 'new'), r('deployment/b', 'same'), r('deployment/c', 'add')],
      [r('deployment/a', 'old'), r('deployment/b', 'same'), r('deployment/gone', 'x')]
    );
    // a -> change, c -> add, gone -> destroy, b -> no-op
    const radius = blastRadius(plan);
    expect(radius.resourcesChanged).toBe(3);
  });

  test('a converged (no-op) plan has an empty blast radius', () => {
    const plan = diffState([r('deployment/a', '1')], [r('deployment/a', '1')]);
    const radius = blastRadius(plan);
    expect(radius.resourcesChanged).toBe(0);
    expect(radius.servicesAffected).toEqual([]);
  });

  test('lists the distinct services affected, derived from the resource path prefix', () => {
    const plan = diffState(
      [r('deployment/summarize', 'v2'), r('service/summarize', 'v2'), r('deployment/orders', 'v1')],
      [r('deployment/summarize', 'v1'), r('service/summarize', 'v1'), r('deployment/orders', 'v1')]
    );
    // both summarize resources change -> one affected service; orders is a no-op
    const radius = blastRadius(plan);
    expect(radius.servicesAffected).toEqual(['summarize']);
  });

  test('aggregates services across adds, changes, and destroys, sorted and deduped', () => {
    const plan = diffState(
      [r('deployment/payments', 'new'), r('deployment/summarize', 'v2')],
      [r('deployment/summarize', 'v1'), r('deployment/legacy', 'old')]
    );
    // payments -> add, summarize -> change, legacy -> destroy
    const radius = blastRadius(plan);
    expect(radius.servicesAffected).toEqual(['legacy', 'payments', 'summarize']);
  });

  test('falls back to the whole path when a resource has no prefix segment', () => {
    const plan = diffState([r('fleet-inventory.json', 'b')], [r('fleet-inventory.json', 'a')]);
    const radius = blastRadius(plan);
    expect(radius.servicesAffected).toEqual(['fleet-inventory.json']);
  });

  test('carries the plan summary counts through for review', () => {
    const plan = diffState(
      [r('deployment/payments', 'new'), r('deployment/summarize', 'v2')],
      [r('deployment/summarize', 'v1'), r('deployment/legacy', 'old')]
    );
    expect(blastRadius(plan).summary).toEqual({ add: 1, change: 1, destroy: 1 });
  });
});
