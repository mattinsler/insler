import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

// Invariants for the path-filtered di website workflow (subsystem-branding
// issue 0007, replicating the issue 0004 template): build the di docs site
// whenever a push/PR touches the site's own content — the di-website
// package, the shared theme, or the workflow itself (the build is the test).
// Deploys are split into least-privilege jobs: a PR-scoped preview job that
// posts the deployment URL back to the PR as a sticky comment
// (pull-requests: write scoped to that job only), and a production job that
// only ever deploys from the public mirror repo (mattinsler/insler). Both
// stay inert until the Cloudflare credentials exist.

const repoRoot = new URL('..', import.meta.url).pathname;
const source = await Bun.file(join(repoRoot, '.github/workflows/di-website.yml')).text();
const workflow = Bun.YAML.parse(source) as Record<string, any>;
// YAML 1.1 parsers read the `on:` trigger key as boolean true; tolerate both.
const triggers = workflow['on'] ?? workflow['true'];
const jobs = workflow['jobs'] as Record<string, any>;
const steps: Record<string, any>[] = Object.values(jobs).flatMap(
  (job: any) => job.steps as Record<string, any>[]
);

describe('path filtering', () => {
  test('triggers are content-scoped to the site package itself, not the whole subsystem', () => {
    for (const paths of [triggers.pull_request.paths, triggers.push.paths]) {
      expect(paths).toContain('packages/di/di-website/**');
      // The broad subsystem filter would rebuild/deploy the site on every
      // library change; only site content changes should trigger.
      expect(paths).not.toContain('packages/di/**');
    }
  });

  test('rebuilds when the shared theme changes (the site renders the family identity)', () => {
    expect(triggers.pull_request.paths).toContain('packages/website/theme/**');
    expect(triggers.push.paths).toContain('packages/website/theme/**');
  });

  test('production trigger is default-branch pushes touching the site content', () => {
    expect(triggers.push.branches).toEqual(['main']);
    expect(triggers.push.paths).toContain('packages/di/di-website/**');
  });

  test('re-runs when the workflow itself changes', () => {
    expect(triggers.pull_request.paths).toContain('.github/workflows/di-website.yml');
    expect(triggers.push.paths).toContain('.github/workflows/di-website.yml');
  });
});

describe('build job', () => {
  test('builds the di docs site (the build is the test)', () => {
    const build = (jobs['build'].steps as Record<string, any>[]).find(
      (s) => typeof s['run'] === 'string' && s['run'].includes('build')
    );
    expect(build?.['run']).toContain('@insler/di-website');
  });

  test('hands the built site to the deploy jobs as an artifact', () => {
    const upload = (jobs['build'].steps as Record<string, any>[]).find(
      (s) => typeof s['uses'] === 'string' && s['uses'].startsWith('actions/upload-artifact@')
    );
    expect(upload?.['with']?.path).toBe('packages/di/di-website/dist');
    for (const deploy of ['preview', 'production']) {
      expect(jobs[deploy].needs).toBe('build');
      const download = (jobs[deploy].steps as Record<string, any>[]).find(
        (s) => typeof s['uses'] === 'string' && s['uses'].startsWith('actions/download-artifact@')
      );
      expect(download?.['with']?.path).toBe('packages/di/di-website/dist');
    }
  });
});

describe('permissions', () => {
  test('top-level permissions are empty; each job declares its own minimum', () => {
    expect(workflow['permissions']).toEqual({});
  });

  test('pull-requests: write is scoped to the preview job only (the sticky comment needs it)', () => {
    expect(jobs['preview'].permissions).toEqual({ 'pull-requests': 'write' });
    expect(jobs['build'].permissions?.['pull-requests']).toBeUndefined();
    expect(jobs['production'].permissions?.['pull-requests']).toBeUndefined();
  });
});

describe('deploy jobs', () => {
  const deploys = steps.filter(
    (s) => typeof s['uses'] === 'string' && s['uses'].startsWith('cloudflare/wrangler-action@')
  );

  test('preview and production deploys both exist, pinned by commit SHA', () => {
    expect(deploys).toHaveLength(2);
    for (const step of deploys) {
      expect(step['uses']).toMatch(/^cloudflare\/wrangler-action@[0-9a-f]{40}/);
    }
  });

  test('both deploys publish the di site build to its own Cloudflare project', () => {
    for (const step of deploys) {
      expect(step['with']?.command).toContain('packages/di/di-website/dist');
      expect(step['with']?.command).toContain('--project-name=di-insler-dev');
    }
  });

  test('preview deploys run on pull requests only, in any repository', () => {
    expect(String(jobs['preview'].if)).toContain("github.event_name == 'pull_request'");
    expect(String(jobs['preview'].if)).not.toContain('github.repository');
  });

  test('production only ever deploys from the public mirror repo, on default-branch pushes', () => {
    const condition = String(jobs['production'].if);
    expect(condition).toContain("github.event_name == 'push'");
    expect(condition).toContain("github.ref == 'refs/heads/main'");
    expect(condition).toContain("github.repository == 'mattinsler/insler'");
  });

  test('every deploy is inert until the Cloudflare credentials exist in CI secrets', () => {
    for (const step of deploys) {
      expect(String(step['if'])).toContain("steps.cloudflare.outputs.available == 'true'");
      expect(step['with']?.apiToken).toBe('${{ secrets.CLOUDFLARE_API_TOKEN }}');
      expect(step['with']?.accountId).toBe('${{ secrets.CLOUDFLARE_ACCOUNT_ID }}');
    }
    for (const job of ['preview', 'production']) {
      const guard = (jobs[job].steps as Record<string, any>[]).find(
        (s) => s['id'] === 'cloudflare'
      );
      expect(guard).toBeDefined();
    }
  });
});

describe('sticky preview-URL comment', () => {
  const comment = (jobs['preview'].steps as Record<string, any>[]).find(
    (s) => typeof s['uses'] === 'string' && s['uses'].startsWith('actions/github-script@')
  );

  test('lives in the preview job, pinned by commit SHA, gated on a successful deploy URL', () => {
    expect(comment).toBeDefined();
    expect(comment?.['uses']).toMatch(/^actions\/github-script@[0-9a-f]{40}/);
    expect(String(comment?.['if'])).toContain("steps.deploy.outputs.deployment-url != ''");
  });

  test('receives the wrangler deployment-url via env, never inline interpolation (no template injection)', () => {
    expect(comment?.['env']?.DEPLOYMENT_URL).toBe('${{ steps.deploy.outputs.deployment-url }}');
    expect(comment?.['with']?.script).not.toContain('${{');
  });

  test('is sticky: finds its hidden marker and updates in place, else creates', () => {
    const script = String(comment?.['with']?.script);
    expect(script).toContain('<!-- di-website-preview-url -->');
    expect(script).toContain('updateComment');
    expect(script).toContain('createComment');
  });
});

describe('release wait-gate coexistence', () => {
  test('the release gate polls runs by head_sha, so a path-filtered workflow that never ran is absent, not blocking', async () => {
    const release = await Bun.file(join(repoRoot, '.github/workflows/release.yml')).text();
    expect(release).toContain('head_sha=');
    // The gate enumerates whatever ran for the commit — it must not hardcode
    // a list of workflow names that would expect this one to always run.
    expect(release).not.toContain('DI Website');
    // Skipped runs are tolerated, not treated as failures.
    expect(release).toContain('"skipped"');
  });
});
