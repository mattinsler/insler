import { describe, expect, test } from 'bun:test';

import { Contract } from '@insler/rpc/contract';
import { defineService } from '@insler/service';
import type { IsolationTier, ScaleConfig, ServiceKind } from '@insler/service';
import { expectTypeOf } from 'expect-type';
import { z } from 'zod';

import { buildFleetManifest } from '../../fleet/index.js';
import type { FleetManifest } from '../../fleet/index.js';
import type { GeneratedFile, GeneratorOptions, GeneratorPlugin } from '../types.js';
import { kubernetesPlugin } from './kubernetes.js';

// --- fixtures: real FleetManifests built from the model only (never the scanner) ---

interface ServiceSpec {
  readonly name: string;
  readonly kind?: ServiceKind;
  readonly isolation?: IsolationTier;
  readonly needs?: readonly string[];
  readonly scale?: ScaleConfig;
  readonly taskQueue?: string;
}

function serviceOf(spec: ServiceSpec) {
  const contract = Contract.create(spec.name.replace(/\./g, '-'), {
    version: '1.0.0',
    methods: {
      run: { input: z.object({ x: z.string() }), output: z.object({ y: z.string() }) },
    },
  });
  const kind = spec.kind ?? 'persistent';
  if (kind === 'workflow') {
    return defineService({
      name: spec.name,
      kind: 'workflow',
      contract,
      taskQueue: spec.taskQueue ?? `${spec.name}-tq`,
      ...(spec.isolation !== undefined ? { isolation: spec.isolation } : {}),
      ...(spec.needs !== undefined ? { needs: spec.needs } : {}),
      ...(spec.scale !== undefined ? { scale: spec.scale } : {}),
    });
  }
  return defineService({
    name: spec.name,
    kind,
    contract,
    ...(spec.isolation !== undefined ? { isolation: spec.isolation } : {}),
    ...(spec.needs !== undefined ? { needs: spec.needs } : {}),
    ...(spec.scale !== undefined ? { scale: spec.scale } : {}),
  });
}

function manifestOf(...specs: readonly ServiceSpec[]): FleetManifest {
  const scanned = specs.map((spec) => ({
    service: serviceOf(spec),
    file: `/virtual/${spec.name}.def.ts`,
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

// --- a minimal, dependency-free YAML reader good enough to assert manifest shape ---
//
// We assert against parsed documents (not raw substrings) so tests check the
// real structure the plugin emits. Bun ships no YAML parser, so this is a tiny
// reader that handles exactly the subset the plugin emits: nested maps, lists
// of maps/scalars, quoted/plain scalars, numbers, and booleans.
type Yaml = null | boolean | number | string | Yaml[] | { [k: string]: Yaml };

function parseYaml(text: string): Yaml {
  const lines = text.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  let i = 0;

  const indentOf = (l: string): number => l.length - l.trimStart().length;

  const scalar = (raw: string): Yaml => {
    const s = raw.trim();
    if (s === '' || s === '{}' || s === '[]') return s === '[]' ? [] : s === '{}' ? {} : '';
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null') return null;
    if (/^-?\d+$/.test(s)) return Number(s);
    if (/^".*"$/.test(s)) return s.slice(1, -1);
    if (/^'.*'$/.test(s)) return s.slice(1, -1);
    return s;
  };

  const parseBlock = (indent: number): Yaml => {
    // Decide list vs map by the first line at this indent.
    if (i >= lines.length) return {};
    const first = lines[i] as string;
    const firstIndent = indentOf(first);
    if (firstIndent < indent) return {};

    if (first.trimStart().startsWith('- ')) {
      const arr: Yaml[] = [];
      while (i < lines.length) {
        const line = lines[i] as string;
        if (indentOf(line) !== indent || !line.trimStart().startsWith('- ')) break;
        i++;
        const rest = line.trimStart().slice(2);
        if (rest.includes(':') && !rest.startsWith('{')) {
          // list of maps: the first key sits on the dash line, deeper keys follow.
          const obj: Record<string, Yaml> = {};
          const childIndent = indent + 2;
          // re-add the first key as a synthetic line at childIndent
          lines.splice(i, 0, ' '.repeat(childIndent) + rest);
          const sub = parseBlock(childIndent);
          Object.assign(obj, sub as Record<string, Yaml>);
          arr.push(obj);
        } else {
          arr.push(scalar(rest));
        }
      }
      return arr;
    }

    const obj: Record<string, Yaml> = {};
    while (i < lines.length) {
      const line = lines[i] as string;
      if (indentOf(line) !== indent) break;
      const trimmed = line.trim();
      const colon = trimmed.indexOf(':');
      const key = trimmed.slice(0, colon).trim();
      const after = trimmed.slice(colon + 1).trim();
      i++;
      if (after === '') {
        // nested block (map or list) at deeper indent, or empty
        if (i < lines.length && indentOf(lines[i] as string) > indent) {
          obj[key] = parseBlock(indentOf(lines[i] as string));
        } else if (
          i < lines.length &&
          indentOf(lines[i] as string) === indent &&
          (lines[i] as string).trim().startsWith('- ')
        ) {
          obj[key] = parseBlock(indent);
        } else {
          obj[key] = {};
        }
      } else {
        obj[key] = scalar(after);
      }
    }
    return obj;
  };

  return parseBlock(indentOf(lines[0] as string));
}

function filesByKind(files: readonly GeneratedFile[]): Map<string, Array<Record<string, Yaml>>> {
  const byKind = new Map<string, Array<Record<string, Yaml>>>();
  for (const f of files) {
    const doc = parseYaml(f.content) as Record<string, Yaml>;
    const kind = doc['kind'] as string;
    const list = byKind.get(kind) ?? [];
    list.push(doc);
    byKind.set(kind, list);
  }
  return byKind;
}

function get(obj: Yaml, path: string): Yaml {
  let cur: Yaml = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur))
      return undefined as unknown as Yaml;
    cur = (cur as Record<string, Yaml>)[seg] as Yaml;
  }
  return cur;
}

describe('kubernetesPlugin — plugin shape', () => {
  test('is a GeneratorPlugin with a stable name', () => {
    expectTypeOf(kubernetesPlugin).toMatchTypeOf<GeneratorPlugin>();
    expect(kubernetesPlugin.name).toBe('kubernetes');
  });

  test('emits yaml-format files only', () => {
    const files = kubernetesPlugin.generate(manifestOf({ name: 'orders.api' }), OPTIONS);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f.format).toBe('yaml');
      expect(f.path.endsWith('.yaml')).toBe(true);
    }
  });
});

// AC1 — produces valid K8s YAML for each service declaration
describe('AC1 — valid K8s YAML per service', () => {
  test('emits a Deployment + ServiceAccount for every service', () => {
    const files = kubernetesPlugin.generate(
      manifestOf({ name: 'orders.api' }, { name: 'billing.worker' }),
      OPTIONS
    );
    const byKind = filesByKind(files);
    expect((byKind.get('Deployment') ?? []).length).toBe(2);
    expect((byKind.get('ServiceAccount') ?? []).length).toBe(2);
  });

  test('every document carries apiVersion, kind, and metadata.name', () => {
    const files = kubernetesPlugin.generate(manifestOf({ name: 'orders.api' }), OPTIONS);
    for (const f of files) {
      const doc = parseYaml(f.content) as Record<string, Yaml>;
      expect(typeof doc['apiVersion']).toBe('string');
      expect(typeof doc['kind']).toBe('string');
      expect(typeof get(doc, 'metadata.name')).toBe('string');
      expect((get(doc, 'metadata.name') as string).length).toBeGreaterThan(0);
    }
  });

  test('resource names are DNS-1123 safe (lowercase, no dots)', () => {
    const files = kubernetesPlugin.generate(manifestOf({ name: 'orders.summarize' }), OPTIONS);
    for (const f of files) {
      const doc = parseYaml(f.content) as Record<string, Yaml>;
      const name = get(doc, 'metadata.name') as string;
      expect(name).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    }
  });

  test('workflow service compiles to a long-running worker Deployment (never a Job)', () => {
    const files = kubernetesPlugin.generate(
      manifestOf({ name: 'orders.saga', kind: 'workflow', taskQueue: 'orders-tq' }),
      OPTIONS
    );
    const byKind = filesByKind(files);
    expect(byKind.has('Job')).toBe(false);
    const dep = (byKind.get('Deployment') ?? [])[0] as Record<string, Yaml>;
    expect(dep).toBeDefined();
    // workflow inherits persistent's floor (>= 1): never scaled to zero.
    expect(get(dep, 'spec.replicas')).toBeGreaterThanOrEqual(1);
  });

  test('persistent service has replicas >= 1; ephemeral starts at its floor (0)', () => {
    const persistent = filesByKind(
      kubernetesPlugin.generate(manifestOf({ name: 'svc.persistent', kind: 'persistent' }), OPTIONS)
    );
    const ephemeral = filesByKind(
      kubernetesPlugin.generate(manifestOf({ name: 'svc.ephemeral', kind: 'ephemeral' }), OPTIONS)
    );
    expect(
      get((persistent.get('Deployment') ?? [])[0] as Yaml, 'spec.replicas')
    ).toBeGreaterThanOrEqual(1);
    expect(get((ephemeral.get('Deployment') ?? [])[0] as Yaml, 'spec.replicas')).toBe(0);
  });
});

// AC2 — Deployment spec includes correct RuntimeClass from isolation field
describe('AC2 — runtimeClassName from effectiveIsolation', () => {
  function runtimeClassFor(isolation: IsolationTier | undefined): Yaml {
    const files = kubernetesPlugin.generate(
      manifestOf(isolation === undefined ? { name: 'svc.x' } : { name: 'svc.x', isolation }),
      OPTIONS
    );
    const dep = (filesByKind(files).get('Deployment') ?? [])[0] as Record<string, Yaml>;
    return get(dep, 'spec.template.spec.runtimeClassName');
  }

  test('gvisor isolation sets runtimeClassName: gvisor', () => {
    expect(runtimeClassFor('gvisor')).toBe('gvisor');
  });

  test('microvm isolation sets a runtimeClassName', () => {
    expect(typeof runtimeClassFor('microvm')).toBe('string');
    expect((runtimeClassFor('microvm') as string).length).toBeGreaterThan(0);
  });

  test('default isolation emits no runtimeClassName (standard runc)', () => {
    // default == standard container; omitting runtimeClassName uses the cluster default.
    expect(runtimeClassFor(undefined)).toBeUndefined();
    expect(runtimeClassFor('default')).toBeUndefined();
  });
});

// AC3 — ServiceAccount created per service with workload-identity annotations
describe('AC3 — ServiceAccount per service with workload-identity annotations', () => {
  test('ServiceAccount name is derived from the service identity', () => {
    const files = kubernetesPlugin.generate(manifestOf({ name: 'orders.summarize' }), OPTIONS);
    const sa = (filesByKind(files).get('ServiceAccount') ?? [])[0] as Record<string, Yaml>;
    expect(sa).toBeDefined();
    const name = get(sa, 'metadata.name') as string;
    // name reflects the service's own name segment
    expect(name).toContain('summarize');
  });

  test('ServiceAccount carries workload-identity annotations keyed to the qualified identity', () => {
    const files = kubernetesPlugin.generate(manifestOf({ name: 'orders.summarize' }), OPTIONS);
    const sa = (filesByKind(files).get('ServiceAccount') ?? [])[0] as Record<string, Yaml>;
    const annotations = get(sa, 'metadata.annotations') as Record<string, Yaml>;
    expect(annotations).toBeDefined();
    // at least one annotation, and the qualified identity appears as a value
    const values = Object.values(annotations).map(String);
    expect(values.some((v) => v.includes('prod.orders.summarize'))).toBe(true);
  });

  test('the Deployment pod runs under the generated ServiceAccount', () => {
    const files = kubernetesPlugin.generate(manifestOf({ name: 'orders.summarize' }), OPTIONS);
    const byKind = filesByKind(files);
    const sa = (byKind.get('ServiceAccount') ?? [])[0] as Record<string, Yaml>;
    const dep = (byKind.get('Deployment') ?? [])[0] as Record<string, Yaml>;
    expect(get(dep, 'spec.template.spec.serviceAccountName')).toBe(get(sa, 'metadata.name'));
  });
});

// AC4 — Resource limits/requests configurable with sensible defaults
describe('AC4 — resource limits/requests configurable with defaults', () => {
  test('default resources are present on the container', () => {
    const files = kubernetesPlugin.generate(manifestOf({ name: 'svc.x' }), OPTIONS);
    const dep = (filesByKind(files).get('Deployment') ?? [])[0] as Record<string, Yaml>;
    const containers = get(dep, 'spec.template.spec.containers') as Yaml[];
    const resources = get(containers[0] as Yaml, 'resources') as Record<string, Yaml>;
    expect(get(resources, 'requests.cpu')).toBeDefined();
    expect(get(resources, 'requests.memory')).toBeDefined();
    expect(get(resources, 'limits.cpu')).toBeDefined();
    expect(get(resources, 'limits.memory')).toBeDefined();
  });

  test('plugin options override the default resources', () => {
    const plugin = kubernetesPlugin.configure({
      resources: {
        requests: { cpu: '250m', memory: '256Mi' },
        limits: { cpu: '2', memory: '1Gi' },
      },
    });
    const dep = (filesByKind(plugin.generate(manifestOf({ name: 'svc.x' }), OPTIONS)).get(
      'Deployment'
    ) ?? [])[0] as Record<string, Yaml>;
    const containers = get(dep, 'spec.template.spec.containers') as Yaml[];
    const resources = get(containers[0] as Yaml, 'resources') as Record<string, Yaml>;
    expect(get(resources, 'requests.cpu')).toBe('250m');
    expect(get(resources, 'limits.memory')).toBe('1Gi');
  });
});

// AC5 — Liveness and readiness probes generated
describe('AC5 — liveness and readiness probes', () => {
  test('container has both liveness and readiness probes', () => {
    const files = kubernetesPlugin.generate(manifestOf({ name: 'svc.x' }), OPTIONS);
    const dep = (filesByKind(files).get('Deployment') ?? [])[0] as Record<string, Yaml>;
    const containers = get(dep, 'spec.template.spec.containers') as Yaml[];
    const container = containers[0] as Yaml;
    expect(get(container, 'livenessProbe')).toBeDefined();
    expect(get(container, 'readinessProbe')).toBeDefined();
  });
});

// AC6 — Queue group configuration passed as env/args
describe('AC6 — queue group configuration passed as env/args', () => {
  test('container env carries a NATS queue group derived from the service', () => {
    const files = kubernetesPlugin.generate(manifestOf({ name: 'orders.api' }), OPTIONS);
    const dep = (filesByKind(files).get('Deployment') ?? [])[0] as Record<string, Yaml>;
    const containers = get(dep, 'spec.template.spec.containers') as Yaml[];
    const env = get(containers[0] as Yaml, 'env') as Array<Record<string, Yaml>>;
    const queueVar = env.find((e) => String(e['name']).includes('QUEUE'));
    expect(queueVar).toBeDefined();
    expect(String(queueVar?.['value']).length).toBeGreaterThan(0);
  });
});

// `needs` -> secret volume mounts/env referencing the {service}-{need} secret (#0015 naming)
describe('needs -> secret bindings via {service}-{need} naming convention', () => {
  test('each need projects a secret-backed env reference named {service}-{need}', () => {
    const files = kubernetesPlugin.generate(
      manifestOf({ name: 'orders.api', needs: ['orders-db', 'valkey'] }),
      OPTIONS
    );
    const dep = (filesByKind(files).get('Deployment') ?? [])[0] as Record<string, Yaml>;
    const containers = get(dep, 'spec.template.spec.containers') as Yaml[];
    const envFrom = get(containers[0] as Yaml, 'envFrom') as Array<Record<string, Yaml>>;
    const secretNames = (envFrom ?? []).map((e) => get(e as Yaml, 'secretRef.name'));
    // {service}-{need} convention (#0015): own-name segment of the service + need
    expect(secretNames).toContain('api-orders-db');
    expect(secretNames).toContain('api-valkey');
  });

  test('a service with no needs references no secrets', () => {
    const files = kubernetesPlugin.generate(manifestOf({ name: 'orders.api' }), OPTIONS);
    const dep = (filesByKind(files).get('Deployment') ?? [])[0] as Record<string, Yaml>;
    const containers = get(dep, 'spec.template.spec.containers') as Yaml[];
    const envFrom = get(containers[0] as Yaml, 'envFrom');
    expect(envFrom === undefined || (envFrom as Yaml[]).length === 0).toBe(true);
  });
});

// AC8 — Idempotent: same input always produces same output
describe('AC8 — deterministic / idempotent output', () => {
  test('same manifest + options yields byte-identical output across runs', () => {
    const m = manifestOf(
      { name: 'orders.api', needs: ['db'] },
      { name: 'billing.worker', kind: 'workflow' }
    );
    const a = kubernetesPlugin.generate(m, OPTIONS);
    const b = kubernetesPlugin.generate(m, OPTIONS);
    expect(a.map((f) => `${f.path}\n${f.content}`)).toEqual(
      b.map((f) => `${f.path}\n${f.content}`)
    );
  });

  test('output is independent of service declaration order', () => {
    const f1 = kubernetesPlugin.generate(manifestOf({ name: 'a.svc' }, { name: 'b.svc' }), OPTIONS);
    const f2 = kubernetesPlugin.generate(manifestOf({ name: 'b.svc' }, { name: 'a.svc' }), OPTIONS);
    const norm = (fs: readonly GeneratedFile[]) =>
      [...fs].map((f) => `${f.path}\n${f.content}`).sort();
    expect(norm(f1)).toEqual(norm(f2));
  });

  test('emits unique paths (no collision when registered on the engine)', () => {
    const files = kubernetesPlugin.generate(
      manifestOf({ name: 'orders.api', needs: ['db'] }, { name: 'billing.worker' }),
      OPTIONS
    );
    const paths = files.map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

// optional Service (ClusterIP) + ConfigMap
describe('optional Service (ClusterIP) and ConfigMap', () => {
  test('emits a ClusterIP Service for the workload', () => {
    const files = kubernetesPlugin.generate(manifestOf({ name: 'orders.api' }), OPTIONS);
    const svc = (filesByKind(files).get('Service') ?? [])[0] as Record<string, Yaml>;
    expect(svc).toBeDefined();
    expect(get(svc, 'spec.type')).toBe('ClusterIP');
  });

  test('emits a ConfigMap carrying non-secret config', () => {
    const files = kubernetesPlugin.generate(manifestOf({ name: 'orders.api' }), OPTIONS);
    const cm = (filesByKind(files).get('ConfigMap') ?? [])[0] as Record<string, Yaml>;
    expect(cm).toBeDefined();
    expect(get(cm, 'data')).toBeDefined();
  });
});
