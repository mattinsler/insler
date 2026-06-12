import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

// Invariants for the path-filtered serde integration workflow
// (subsystem-branding issue 0008, replicating the issue 0005 template and the
// di replication): run the serde subsystem's private integration suite —
// toolchain via the shared setup action, build the published surface, run the
// suite — only when the serde directory changes, and coexist with the
// unchanged repo-wide workflows and the release workflow's
// wait-for-other-workflows gate. serde needs no real infrastructure (it is
// in-process serialization), so like the di replication the job provisions
// nothing beyond the toolchain.

const repoRoot = new URL('..', import.meta.url).pathname;
const source = await Bun.file(join(repoRoot, '.github/workflows/serde-integration.yml')).text();
const workflow = Bun.YAML.parse(source) as Record<string, any>;
// YAML 1.1 parsers read the `on:` trigger key as boolean true; tolerate both.
const triggers = workflow['on'] ?? workflow['true'];
const steps: Record<string, any>[] = Object.values(workflow['jobs'] as Record<string, any>).flatMap(
  (job: any) => job.steps as Record<string, any>[]
);

describe('path filtering', () => {
  test('runs on any PR touching the serde subsystem directory', () => {
    expect(triggers.pull_request.paths).toContain('packages/serde/**');
  });

  test('runs on default-branch pushes touching the serde subsystem directory', () => {
    expect(triggers.push.branches).toEqual(['main']);
    expect(triggers.push.paths).toContain('packages/serde/**');
  });

  test('re-runs when the workflow itself changes', () => {
    expect(triggers.pull_request.paths).toContain('.github/workflows/serde-integration.yml');
    expect(triggers.push.paths).toContain('.github/workflows/serde-integration.yml');
  });
});

describe('integration job', () => {
  test('provisions the toolchain via the shared setup action', () => {
    const setup = steps.find((s) => s['uses'] === './.github/actions/setup-workspace');
    expect(setup).toBeDefined();
  });

  test('provisions no infrastructure beyond the toolchain (serde runs in-process)', () => {
    // Real infrastructure only where the subsystem actually needs it
    // (subsystem-branding PRD) — serde needs none, so no infra appears
    // anywhere in the workflow.
    expect(source).not.toMatch(/nats|redis|postgres|kafka/i);
  });

  test('builds the published surface before the suite (consumer-grade imports resolve to dist)', () => {
    const runs = steps.map((s) => s['run']).filter((r): r is string => typeof r === 'string');
    const buildIndex = runs.findIndex((r) => r.includes('bun run build'));
    const suiteIndex = runs.findIndex((r) => r.includes('@insler/serde-integration'));
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(suiteIndex).toBeGreaterThan(buildIndex);
  });

  test('runs the integration suite via its non-default script', () => {
    const suite = steps.find(
      (s) => typeof s['run'] === 'string' && s['run'].includes('@insler/serde-integration')
    );
    expect(suite?.['run']).toContain('test:integration');
  });

  test('checkout is pinned and credential-free (workflow-lint conventions)', () => {
    const checkout = steps.find(
      (s) => typeof s['uses'] === 'string' && s['uses'].startsWith('actions/checkout@')
    );
    expect(checkout?.['uses']).toMatch(/^actions\/checkout@[0-9a-f]{40}/);
    expect(checkout?.['with']?.['persist-credentials']).toBe(false);
  });
});

describe('coexistence with the repo-wide workflows', () => {
  test('the release gate polls runs by head_sha, so a path-filtered workflow that never ran is absent, not blocking', async () => {
    const release = await Bun.file(join(repoRoot, '.github/workflows/release.yml')).text();
    expect(release).toContain('head_sha=');
    // The gate enumerates whatever ran for the commit — it must not hardcode
    // a list of workflow names that would expect this one to always run.
    expect(release).not.toContain('Integration');
    // Skipped runs are tolerated, not treated as failures.
    expect(release).toContain('"skipped"');
  });

  test('the repo-wide CI matrix is untouched by the integration suite', async () => {
    const ci = await Bun.file(join(repoRoot, '.github/workflows/ci.yml')).text();
    expect(ci).not.toContain('serde-integration');
  });
});
