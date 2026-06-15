import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runApply, runGenerate, runPlan, runScan } from '@insler/cli';

// The @insler/cli sibling exercised consumer-grade (subsystem-branding issue
// 0010): every command's programmatic export — the published consumer entry —
// driven in-process with injected IO sinks over the same declaration fixtures
// the umbrella tests scan. The binary is thin wiring over these run*
// functions, so this is the deepest in-process seam the CLI offers; no
// process is spawned.

const VALID_DIR = new URL('./fixtures/valid/', import.meta.url).pathname;
const INVALID_DIR = new URL('./fixtures/invalid/', import.meta.url).pathname;

interface CollectedIO {
  readonly io: { out: (line: string) => void; err: (line: string) => void };
  readonly out: string[];
  readonly err: string[];
}

function collect(): CollectedIO {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

describe('insler scan (runScan)', () => {
  test('summarizes a valid fleet and exits 0', async () => {
    const { io, out } = collect();
    expect(await runScan({ cwd: VALID_DIR }, io)).toBe(0);

    const summary = out.join('\n');
    expect(summary).toContain('Discovered 2 service(s)');
    expect(summary).toContain('greeter (ephemeral)');
    expect(summary).toContain('orders (persistent)');
    expect(summary).toContain('Graph: 2 edge(s)');
    expect(summary).toContain('Exposed routes: 1');
  });

  test('emits the full manifest as JSON with --json', async () => {
    const { io, out } = collect();
    expect(await runScan({ cwd: VALID_DIR, json: true }, io)).toBe(0);

    const manifest = JSON.parse(out.join('\n'));
    expect(manifest.services.map((s: { name: string }) => s.name)).toEqual(['greeter', 'orders']);
  });

  test('reports each cross-service error with kind and locations, exits 1', async () => {
    const { io, err } = collect();
    expect(await runScan({ cwd: INVALID_DIR }, io)).toBe(1);

    const diagnostics = err.join('\n');
    expect(diagnostics).toContain('[duplicate-service-name]');
    expect(diagnostics).toContain('dupe-a.service.ts');
    expect(diagnostics).toContain('dupe-b.service.ts');
  });
});

describe('insler generate (runGenerate)', () => {
  test('--dry-run previews the generated artifacts without writing', async () => {
    const { io, out } = collect();
    expect(await runGenerate({ cwd: VALID_DIR, dryRun: true }, io)).toBe(0);

    const preview = out.join('\n');
    // The dry-run sink receives each artifact's header and rendered content.
    expect(preview).toMatch(/^# .+ \(\w+\)$/m);
    expect(preview).toContain('greeter');
    expect(preview).toContain('orders');
  });
});

describe('insler plan (runPlan)', () => {
  test('plans against an empty actual state and renders the Atlas-style plan', async () => {
    const { io, out } = collect();
    expect(await runPlan({ cwd: VALID_DIR }, io)).toBe(0);

    const rendered = out.join('\n');
    expect(rendered).toMatch(/^Plan: \d+ to add, 0 to change, 0 to destroy/m);
    expect(rendered).toContain('(new)');
  });

  test('--comment renders the CI PR Markdown with the blast radius', async () => {
    const { io, out } = collect();
    expect(await runPlan({ cwd: VALID_DIR, comment: true }, io)).toBe(0);

    const comment = out.join('\n');
    expect(comment).toContain('## insler plan');
    expect(comment).toContain('**Blast radius:**');
    // The CLI derives desired state via the fleet-inventory reference plugin,
    // so the planned artifact is the fleet inventory itself.
    expect(comment).toContain('fleet-inventory');
  });
});

describe('insler apply (runApply, non-production)', () => {
  test('the ungated dev apply converges the state snapshot; a re-plan is a no-op', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'platform-integration-'));
    try {
      const statePath = join(dir, 'state.json');

      const apply = collect();
      expect(await runApply({ cwd: VALID_DIR, statePath }, apply.io)).toBe(0);
      expect(apply.out.join('\n')).toMatch(/Applied: \d+ added, 0 changed, 0 destroyed\./);

      // The snapshot now holds the applied state: planning again converges.
      const replan = collect();
      expect(await runPlan({ cwd: VALID_DIR, statePath }, replan.io)).toBe(0);
      expect(replan.out.join('\n')).toContain('Plan: 0 to add, 0 to change, 0 to destroy');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
