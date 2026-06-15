import { describe, expect, test } from 'bun:test';

import { scanFleet } from '@insler/platform/fleet';
import type { FleetManifest } from '@insler/platform/fleet';
import {
  createGenerator,
  fleetInventoryPlugin,
  kubernetesPlugin,
} from '@insler/platform/generator';
import type { GeneratorOptions } from '@insler/platform/generator';
import {
  applyGated,
  createMemoryStateProvider,
  createReconciler,
  toResources,
} from '@insler/platform/reconciler';
import type { AuditRecord } from '@insler/platform/reconciler';

// The /generator and /reconciler entrypoints exercised consumer-grade as one
// pipeline (subsystem-branding issue 0010): the scanned fixture fleet
// compiled into deterministic artifacts, those artifacts planned and applied
// through the in-process engine behind the StateProvider seam, and the
// production gate auditing every attempt. No infrastructure anywhere — the
// engine's state backend is the injected provider, exactly the seam a real
// backend would implement.

const VALID_DIR = new URL('./fixtures/valid/', import.meta.url).pathname;
const OPTIONS: GeneratorOptions = { target: 'kubernetes', outputDir: 'deploy', environment: 'dev' };

async function scanManifest(): Promise<FleetManifest> {
  const result = await scanFleet({ cwd: VALID_DIR });
  if (!result.manifest) throw new Error('fixture fleet must be valid');
  return result.manifest;
}

describe('generating artifacts from the scanned fleet', () => {
  test('the kubernetes plugin derives artifacts for every service, sorted for stable diffs', async () => {
    const manifest = await scanManifest();
    const generation = createGenerator().use(kubernetesPlugin).generate(manifest, OPTIONS);

    expect(generation.files.length).toBeGreaterThan(0);
    const paths = generation.files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
    // Every service in the fleet is represented in the generated set.
    for (const service of ['greeter', 'orders']) {
      expect(generation.files.some((f) => f.content.includes(service))).toBe(true);
    }
  });

  test('generation is pure and deterministic — same manifest, same files', async () => {
    const manifest = await scanManifest();
    const first = createGenerator().use(kubernetesPlugin).generate(manifest, OPTIONS);
    const second = createGenerator().use(kubernetesPlugin).generate(manifest, OPTIONS);

    expect(second.files).toEqual(first.files);
  });

  test('the file-level diff classifies added and unchanged output across generations', async () => {
    const manifest = await scanManifest();
    const generator = createGenerator().use(kubernetesPlugin);
    const previous = generator.generate(manifest, OPTIONS);
    const next = createGenerator()
      .use(kubernetesPlugin)
      .use(fleetInventoryPlugin)
      .generate(manifest, OPTIONS);

    const diff = generator.diff(previous.files, next.files);
    expect(diff.added.length).toBeGreaterThan(0);
    expect(diff.unchanged).toEqual(previous.files.map((f) => f.path));
    expect(diff.changed).toEqual([]);
    expect(diff.removed).toEqual([]);
  });
});

describe('planning and applying through the StateProvider seam', () => {
  test('plan → apply → no-op: the consumer convergence loop', async () => {
    const manifest = await scanManifest();
    const desired = toResources(
      createGenerator().use(kubernetesPlugin).generate(manifest, OPTIONS).files
    );
    const reconciler = createReconciler(createMemoryStateProvider());

    const plan = await reconciler.plan(desired);
    expect(plan.isNoOp).toBe(false);
    expect(plan.summary.add).toBe(desired.length);
    // Plans are plain, JSON-serializable data — audit-loggable as-is.
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan as never);
    expect(reconciler.render(plan)).toContain(`${desired.length} to add`);

    const applied = await reconciler.apply(plan);
    expect(applied.applied).toBe(true);

    const converged = await reconciler.plan(desired);
    expect(converged.isNoOp).toBe(true);
  });

  test('drift is detected against the last-applied desired state', async () => {
    const manifest = await scanManifest();
    const desired = toResources(
      createGenerator().use(kubernetesPlugin).generate(manifest, OPTIONS).files
    );
    const provider = createMemoryStateProvider();
    const reconciler = createReconciler(provider);
    await reconciler.apply(await reconciler.plan(desired));

    // Out-of-band drift: live state mutates, last-applied intent does not.
    const [first, ...rest] = desired;
    await provider.driftActual([{ ...first!, content: `${first!.content}\n# drifted` }, ...rest]);

    const report = await reconciler.detectDrift();
    expect(report.hasDrift).toBe(true);
    expect(report.drifted).toEqual([first!.path]);
    expect(report.plan.isNoOp).toBe(false);
  });

  test('the production gate audits every attempt and rejects a stale plan', async () => {
    const manifest = await scanManifest();
    const desired = toResources(
      createGenerator().use(kubernetesPlugin).generate(manifest, OPTIONS).files
    );
    const reconciler = createReconciler(createMemoryStateProvider());
    const records: AuditRecord[] = [];
    const audit = {
      record: (entry: AuditRecord): Promise<void> => {
        records.push(entry);
        return Promise.resolve();
      },
    };
    const now = (): Date => new Date('2026-06-11T00:00:00.000Z');

    const plan = await reconciler.plan(desired);
    const first = await applyGated(reconciler, plan, { operator: 'ci@insler', audit, now });
    expect(first.outcome).toBe('applied');

    // Replaying the same plan is stale — it was diffed against an actual
    // state that no longer holds. The gate refuses it and still audits.
    const replay = await applyGated(reconciler, plan, { operator: 'ci@insler', audit, now });
    expect(replay.outcome).toBe('rejected');

    expect(records.map((r) => r.outcome)).toEqual(['applied', 'rejected']);
    for (const record of records) {
      expect(record.operator).toBe('ci@insler');
      expect(record.timestamp).toBe('2026-06-11T00:00:00.000Z');
      // SOC 2 load-bearing: records must round-trip JSON.stringify.
      expect(JSON.parse(JSON.stringify(record))).toEqual(record as never);
    }
  });
});
