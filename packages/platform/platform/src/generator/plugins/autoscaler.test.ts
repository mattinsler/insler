import { describe, expect, test } from 'bun:test';

import { Contract } from '@insler/rpc/contract';
import { defineService } from '@insler/service';
import type { ScaleConfig, ServiceKind } from '@insler/service';
import { expectTypeOf } from 'expect-type';
import { z } from 'zod';

import { buildFleetManifest } from '../../fleet/index.js';
import type { FleetManifest } from '../../fleet/index.js';
import type { GeneratedFile, GeneratorOptions, GeneratorPlugin } from '../types.js';
import { autoscalerPlugin } from './autoscaler.js';
import type { AutoscalerOptions } from './autoscaler.js';

// --- fixtures: a real FleetManifest built from the model only (no scanner) ---

interface Decl {
  readonly name: string;
  readonly kind: ServiceKind;
  readonly scale?: ScaleConfig;
  readonly taskQueue?: string;
}

function svc(decl: Decl) {
  const contract = Contract.create(decl.name, {
    version: '1.0.0',
    methods: {
      run: { input: z.object({ x: z.string() }), output: z.object({ y: z.string() }) },
    },
  });
  // Discriminated-union input: workflow carries taskQueue, others must not.
  if (decl.kind === 'workflow') {
    return defineService({
      name: decl.name,
      kind: 'workflow',
      contract,
      taskQueue: decl.taskQueue ?? `${decl.name}-tq`,
      ...(decl.scale !== undefined ? { scale: decl.scale } : {}),
    });
  }
  return defineService({
    name: decl.name,
    kind: decl.kind,
    contract,
    ...(decl.scale !== undefined ? { scale: decl.scale } : {}),
  });
}

function manifestOf(...decls: readonly Decl[]): FleetManifest {
  const scanned = decls.map((decl) => ({
    service: svc(decl),
    file: `/virtual/${decl.name}.def.ts`,
  }));
  const result = buildFleetManifest(scanned);
  if (result.manifest === undefined) {
    throw new Error(`fixture manifest invalid: ${JSON.stringify(result.errors)}`);
  }
  return result.manifest;
}

const OPTIONS: GeneratorOptions = {
  target: 'kubernetes',
  outputDir: '/unused',
  environment: 'prod',
};

/** Minimal-but-real YAML parse for the deterministic block-style YAML the plugin
 * emits. Proves the output is parseable and round-trips to the expected model
 * (AC1 / AC7 — "valid KEDA CRD YAML"). Supports the nested map/seq subset the
 * plugin produces (2-space indent, `- ` sequence items, `key: value` scalars). */
function parseYaml(text: string): unknown {
  const lines = text.split('\n').filter((l) => l.trimEnd().length > 0);
  let i = 0;

  function indentOf(line: string): number {
    return line.length - line.trimStart().length;
  }

  function unquote(v: string): string | number {
    const t = v.trim();
    if (t.startsWith('"') && t.endsWith('"')) {
      return t.slice(1, -1);
    }
    if (/^-?\d+$/.test(t)) {
      return Number(t);
    }
    return t;
  }

  function parseBlock(indent: number): unknown {
    // Sequence?
    if (
      i < lines.length &&
      indentOf(lines[i]!) === indent &&
      lines[i]!.trimStart().startsWith('- ')
    ) {
      const arr: unknown[] = [];
      while (
        i < lines.length &&
        indentOf(lines[i]!) === indent &&
        lines[i]!.trimStart().startsWith('- ')
      ) {
        const line = lines[i]!;
        const rest = line.trimStart().slice(2);
        // An inline `- key: value` starts a map at indent+2.
        if (rest.includes(':')) {
          // Rewrite the current line to a map entry at indent+2 and parse a map.
          lines[i] = ' '.repeat(indent + 2) + rest;
          arr.push(parseBlock(indent + 2));
        } else {
          i += 1;
          arr.push(unquote(rest));
        }
      }
      return arr;
    }
    // Map.
    const obj: Record<string, unknown> = {};
    while (i < lines.length && indentOf(lines[i]!) === indent) {
      const line = lines[i]!;
      const trimmed = line.trimStart();
      const colon = trimmed.indexOf(':');
      const key = trimmed.slice(0, colon).trim();
      const after = trimmed.slice(colon + 1).trim();
      i += 1;
      if (after.length > 0) {
        obj[key] = unquote(after);
      } else {
        obj[key] = parseBlock(indent + 2);
      }
    }
    return obj;
  }

  return parseBlock(0);
}

function scaledObjectFor(manifest: FleetManifest, name: string, opts?: AutoscalerOptions) {
  const plugin = opts ? autoscalerPlugin(opts) : autoscalerPlugin();
  const files = plugin.generate(manifest, OPTIONS);
  const file = files.find((f) => f.content.includes(`name: ${name}\n`));
  if (file === undefined) {
    throw new Error(
      `no ScaledObject emitted for '${name}'; got ${files.map((f) => f.path).join(', ')}`
    );
  }
  return { file, doc: parseYaml(file.content) as Record<string, any> };
}

// --- AC1 / AC7: valid KEDA ScaledObject CRD YAML ---

describe('autoscaler plugin — KEDA ScaledObject CRD (AC1, AC7)', () => {
  test('is a GeneratorPlugin with a stable name', () => {
    const plugin = autoscalerPlugin();
    expectTypeOf(plugin).toExtend<GeneratorPlugin>();
    expect(typeof plugin.name).toBe('string');
    expect(plugin.name.length).toBeGreaterThan(0);
  });

  test('emits one yaml artifact per service', () => {
    const files = autoscalerPlugin().generate(
      manifestOf({ name: 'a', kind: 'persistent' }, { name: 'b', kind: 'ephemeral' }),
      OPTIONS
    );
    expect(files.length).toBe(2);
    for (const f of files) {
      expect(f.format).toBe('yaml');
      expect(f.path.endsWith('.yaml')).toBe(true);
    }
  });

  test('every emitted document is a valid KEDA ScaledObject', () => {
    const { doc } = scaledObjectFor(manifestOf({ name: 'orders', kind: 'persistent' }), 'orders');
    expect(doc.apiVersion).toBe('keda.sh/v1alpha1');
    expect(doc.kind).toBe('ScaledObject');
    expect(doc.metadata.name).toBe('orders');
    expect(doc.spec.scaleTargetRef.name).toBe('orders');
    expect(Array.isArray(doc.spec.triggers)).toBe(true);
    expect(doc.spec.triggers.length).toBeGreaterThan(0);
  });
});

// --- AC2: ephemeral -> NATS JetStream consumer-lag scaler, min 0 ---

describe('ephemeral services — NATS JetStream consumer-lag scaler, min 0 (AC2)', () => {
  test('emits a nats-jetstream trigger with consumer lag and min 0', () => {
    const { doc } = scaledObjectFor(
      manifestOf({ name: 'summarize', kind: 'ephemeral' }),
      'summarize'
    );
    expect(doc.spec.minReplicaCount).toBe(0);
    const trigger = doc.spec.triggers[0];
    expect(trigger.type).toBe('nats-jetstream');
    expect(trigger.metadata.consumer).toBe('summarize');
    // consumer-lag signal carried as a lagThreshold on the JetStream scaler.
    expect(trigger.metadata.lagThreshold).toBeDefined();
    expect(trigger.metadata.stream).toBeDefined();
    expect(trigger.metadata.natsServerMonitoringEndpoint).toBeDefined();
  });
});

// --- AC3: persistent -> CPU scaler, min >= 1 ---

describe('persistent services — CPU scaler, min >= 1 (AC3)', () => {
  test('emits a cpu trigger with a floor of at least 1', () => {
    const { doc } = scaledObjectFor(manifestOf({ name: 'ledger', kind: 'persistent' }), 'ledger');
    expect(doc.spec.minReplicaCount).toBeGreaterThanOrEqual(1);
    const trigger = doc.spec.triggers[0];
    expect(trigger.type).toBe('cpu');
    expect(trigger.metadata.value).toBeDefined();
  });
});

// --- escape-hatch signals (rps / custom) selected via scale.on override ---
// The kind table maps `rps` to the HTTP edge (#0014); here we only guarantee the
// document stays valid KEDA when an author overrides `on` to an edge/custom signal.

describe('rps / custom signals stay valid KEDA (escape hatch)', () => {
  test('an rps override emits a valid external-scaler trigger keyed on the signal', () => {
    const { doc } = scaledObjectFor(
      manifestOf({ name: 'edge', kind: 'persistent', scale: { on: 'rps', min: 1 } }),
      'edge'
    );
    expect(doc.spec.triggers[0].type).toBe('external');
    expect(doc.spec.triggers[0].metadata.scaler).toBe('rps');
  });

  test('a custom override emits a valid external-scaler trigger keyed on the signal', () => {
    const { doc } = scaledObjectFor(
      manifestOf({ name: 'special', kind: 'persistent', scale: { on: 'custom', min: 1 } }),
      'special'
    );
    expect(doc.spec.triggers[0].type).toBe('external');
    expect(doc.spec.triggers[0].metadata.scaler).toBe('custom');
  });
});

// --- AC4: workflow -> task-queue backlog scaler, min >= 1 ---

describe('workflow services — task-queue backlog scaler, min >= 1 (AC4)', () => {
  test('emits a task-queue-backlog trigger keyed on the task queue, floor >= 1', () => {
    const { doc } = scaledObjectFor(
      manifestOf({ name: 'orchestrator', kind: 'workflow', taskQueue: 'orders-tq' }),
      'orchestrator'
    );
    expect(doc.spec.minReplicaCount).toBeGreaterThanOrEqual(1);
    const trigger = doc.spec.triggers[0];
    // a custom/external scaler watching the Temporal task-queue backlog
    expect(trigger.metadata.taskQueue).toBe('orders-tq');
  });
});

// --- AC5: min/max from scale config respected ---

describe('min/max from scale config respected (AC5)', () => {
  test('an explicit min/max on an ephemeral service overrides the kind default', () => {
    const { doc } = scaledObjectFor(
      manifestOf({
        name: 'warm',
        kind: 'ephemeral',
        scale: { on: 'queue-depth', min: 2, max: 30 },
      }),
      'warm'
    );
    expect(doc.spec.minReplicaCount).toBe(2);
    expect(doc.spec.maxReplicaCount).toBe(30);
  });

  test('an explicit max on a persistent service is respected', () => {
    const { doc } = scaledObjectFor(
      manifestOf({ name: 'api', kind: 'persistent', scale: { on: 'cpu', min: 3, max: 50 } }),
      'api'
    );
    expect(doc.spec.minReplicaCount).toBe(3);
    expect(doc.spec.maxReplicaCount).toBe(50);
  });

  test('when no max is declared, maxReplicaCount falls back to the plugin default ceiling', () => {
    const { doc } = scaledObjectFor(manifestOf({ name: 'nomax', kind: 'persistent' }), 'nomax', {
      defaultMaxReplicas: 7,
    });
    expect(doc.spec.maxReplicaCount).toBe(7);
  });
});

// --- AC6: custom scaling thresholds configurable ---

describe('custom scaling thresholds configurable (AC6)', () => {
  test('the NATS lag threshold is configurable', () => {
    const { doc } = scaledObjectFor(manifestOf({ name: 'e', kind: 'ephemeral' }), 'e', {
      natsLagThreshold: 25,
    });
    expect(doc.spec.triggers[0].metadata.lagThreshold).toBe('25');
  });

  test('the CPU utilization threshold is configurable', () => {
    const { doc } = scaledObjectFor(manifestOf({ name: 'p', kind: 'persistent' }), 'p', {
      cpuThreshold: 80,
    });
    expect(doc.spec.triggers[0].metadata.value).toBe('80');
  });

  test('the task-queue backlog threshold is configurable', () => {
    const { doc } = scaledObjectFor(
      manifestOf({ name: 'w', kind: 'workflow', taskQueue: 'tq' }),
      'w',
      { taskQueueBacklogThreshold: 5 }
    );
    expect(doc.spec.triggers[0].metadata.targetQueueSize).toBe('5');
  });

  test('the NATS monitoring endpoint is configurable', () => {
    const { doc } = scaledObjectFor(manifestOf({ name: 'e', kind: 'ephemeral' }), 'e', {
      natsServerMonitoringEndpoint: 'nats.svc:9999',
    });
    expect(doc.spec.triggers[0].metadata.natsServerMonitoringEndpoint).toBe('nats.svc:9999');
  });
});

// --- Notes: deterministic output ---

describe('deterministic output (Notes)', () => {
  test('same manifest + options yields byte-identical output regardless of service order', () => {
    const a = autoscalerPlugin().generate(
      manifestOf({ name: 'b', kind: 'persistent' }, { name: 'a', kind: 'ephemeral' }),
      OPTIONS
    );
    const b = autoscalerPlugin().generate(
      manifestOf({ name: 'a', kind: 'ephemeral' }, { name: 'b', kind: 'persistent' }),
      OPTIONS
    );
    const norm = (files: readonly GeneratedFile[]) =>
      [...files].sort((x, y) => (x.path < y.path ? -1 : 1)).map((f) => [f.path, f.content]);
    expect(norm(a)).toEqual(norm(b));
  });

  test('files are emitted in path-sorted order', () => {
    const files = autoscalerPlugin().generate(
      manifestOf({ name: 'zebra', kind: 'persistent' }, { name: 'apple', kind: 'persistent' }),
      OPTIONS
    );
    const paths = files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
  });
});

// --- types ---

describe('autoscaler plugin types', () => {
  test('autoscalerPlugin returns a GeneratorPlugin (with and without options)', () => {
    expectTypeOf(autoscalerPlugin()).toExtend<GeneratorPlugin>();
    expectTypeOf(autoscalerPlugin({})).toExtend<GeneratorPlugin>();
    // options are all optional — an empty object satisfies AutoscalerOptions
    expectTypeOf<{}>().toExtend<AutoscalerOptions>();
    expectTypeOf<AutoscalerOptions['natsLagThreshold']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<AutoscalerOptions['cpuThreshold']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<AutoscalerOptions['taskQueueBacklogThreshold']>().toEqualTypeOf<
      number | undefined
    >();
  });
});
