import { describe, expect, test } from 'bun:test';

import { Contract } from '@insler/rpc/contract';
import { defineService } from '@insler/service';
import { expectTypeOf } from 'expect-type';
import { z } from 'zod';

import { buildFleetManifest } from '../../fleet/index.js';
import type { FleetManifest } from '../../fleet/index.js';
import type { GeneratorOptions, GeneratorPlugin } from '../types.js';
import { createSecretBindingPlugin } from './secret-binding.js';
import type { SecretBindingConfig } from './secret-binding.js';

// --- fixtures: real FleetManifests built from the model only (no scanner) ---

interface SvcSpec {
  readonly name: string;
  readonly needs?: readonly string[];
}

/** Build a real FleetManifest from `{ name, needs }` specs via the model. */
function manifestOf(...specs: readonly (string | SvcSpec)[]): FleetManifest {
  const scanned = specs.map((spec) => {
    const { name, needs } = typeof spec === 'string' ? { name: spec, needs: undefined } : spec;
    return {
      service: defineService({
        name,
        kind: 'persistent',
        contract: Contract.create(name, {
          version: '1.0.0',
          methods: {
            run: { input: z.object({ x: z.string() }), output: z.object({ y: z.string() }) },
          },
        }),
        ...(needs !== undefined ? { needs } : {}),
      }),
      file: `/virtual/${name}.def.ts`,
    };
  });
  const result = buildFleetManifest(scanned);
  if (result.manifest === undefined) {
    throw new Error(`fixture manifest invalid: ${JSON.stringify(result.errors)}`);
  }
  return result.manifest;
}

const OPTIONS: GeneratorOptions = {
  target: 'kubernetes',
  outputDir: '/unused',
  environment: 'production',
};

const STORE: SecretBindingConfig = {
  secretStoreRef: { name: 'aws-secretsmanager', kind: 'ClusterSecretStore' },
};

interface Frame {
  readonly indent: number;
  // Either a map container, or a sequence-of-maps container keyed under `key`.
  readonly map?: Record<string, unknown>;
  readonly seq?: Record<string, unknown>[];
}

/** Parse the deterministic, block-style YAML this plugin emits into a tree. */
function parseYaml(content: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  // Stack of containers we can attach children to, deepest last.
  const stack: Frame[] = [{ indent: -1, map: root }];

  const top = (): Frame => stack[stack.length - 1]!;

  for (const raw of content.split('\n')) {
    if (raw.trim() === '' || raw.trim() === '---') continue;
    const indent = raw.length - raw.trimStart().length;
    const body = raw.trim();

    // Pop frames shallower-or-equal to the current indent (for map keys) /
    // strictly shallower (for sequence items handled below).
    if (body.startsWith('- ')) {
      // Sequence item: pop to the frame holding the owning sequence.
      while (top().indent >= indent || top().seq === undefined) {
        if (stack.length === 1) break;
        if (top().seq !== undefined && top().indent < indent) break;
        stack.pop();
      }
      const owner = top();
      const item: Record<string, unknown> = {};
      owner.seq!.push(item);
      // Push the item as a map frame so its sibling keys attach to it.
      stack.push({ indent, map: item });
      const rest = body.slice(2);
      const ci = rest.indexOf(':');
      const k = rest.slice(0, ci).trim();
      const v = rest.slice(ci + 1).trim();
      if (v === '') {
        const child: Record<string, unknown> = {};
        item[k] = child;
        stack.push({ indent: indent + 2, map: child });
      } else {
        item[k] = v;
      }
      continue;
    }

    while (top().indent >= indent) stack.pop();
    const parent = top().map!;
    const ci = body.indexOf(':');
    const key = body.slice(0, ci).trim();
    const value = body.slice(ci + 1).trim();

    if (value === '') {
      // Undetermined: a `data:` style key opens a sequence; everything else a map.
      if (key === 'data') {
        const seq: Record<string, unknown>[] = [];
        parent[key] = seq;
        stack.push({ indent, seq });
      } else {
        const child: Record<string, unknown> = {};
        parent[key] = child;
        stack.push({ indent, map: child });
      }
    } else {
      parent[key] = value;
    }
  }
  return root;
}

/** Pull every emitted file's parsed body, keyed by path. */
function emit(plugin: GeneratorPlugin, manifest: FleetManifest, options = OPTIONS) {
  return plugin.generate(manifest, options);
}

describe('createSecretBindingPlugin', () => {
  // AC1 — one ExternalSecret per service need
  describe('AC1: produces an ExternalSecret per service need', () => {
    test('emits one ExternalSecret file for each declared need', () => {
      const plugin = createSecretBindingPlugin(STORE);
      const files = emit(
        plugin,
        manifestOf({ name: 'session-hub', needs: ['orders-db', 'valkey'] })
      );

      expect(files.length).toBe(2);
      expect(files.every((f) => f.format === 'yaml')).toBe(true);
      for (const f of files) {
        expect(f.content).toContain('kind: ExternalSecret');
        expect(f.content).toContain('apiVersion: external-secrets.io/v1beta1');
      }
    });

    test('a service with no needs emits no files', () => {
      const plugin = createSecretBindingPlugin(STORE);
      expect(emit(plugin, manifestOf('lonely')).length).toBe(0);
    });

    test('emits across multiple services, summing their needs', () => {
      const plugin = createSecretBindingPlugin(STORE);
      const files = emit(
        plugin,
        manifestOf(
          { name: 'session-hub', needs: ['orders-db'] },
          { name: 'billing', needs: ['ledger-db', 'valkey'] }
        )
      );
      expect(files.length).toBe(3);
    });

    test('the metadata name and target name are <service>-<need>', () => {
      const plugin = createSecretBindingPlugin(STORE);
      const [file] = emit(plugin, manifestOf({ name: 'session-hub', needs: ['orders-db'] }));
      const doc = parseYaml(file!.content);
      expect((doc.metadata as Record<string, unknown>).name).toBe('session-hub-orders-db');
      expect((doc.spec as Record<string, unknown>).target).toMatchObject({
        name: 'session-hub-orders-db',
      });
    });
  });

  // AC2 — secret paths follow {environment}/services/{service-name}/{need-name}, keyed on identity
  describe('AC2: secret paths follow the naming convention using service identity', () => {
    test('remoteRef.key is {environment}/services/{service-name}/{need-name}', () => {
      const plugin = createSecretBindingPlugin(STORE);
      const files = emit(
        plugin,
        manifestOf({ name: 'session-hub', needs: ['orders-db', 'valkey'] }),
        { ...OPTIONS, environment: 'production' }
      );
      const keys = files.map((f) => {
        const data = (parseYaml(f.content).spec as Record<string, unknown>).data as Record<
          string,
          unknown
        >[];
        return (data[0]!.remoteRef as Record<string, unknown>).key as string;
      });
      expect(keys.sort()).toEqual([
        'production/services/session-hub/orders-db',
        'production/services/session-hub/valkey',
      ]);
    });

    test('the environment segment reflects the run environment', () => {
      const plugin = createSecretBindingPlugin(STORE);
      const [file] = emit(plugin, manifestOf({ name: 'session-hub', needs: ['orders-db'] }), {
        ...OPTIONS,
        environment: 'staging',
      });
      const data = (parseYaml(file!.content).spec as Record<string, unknown>).data as Record<
        string,
        unknown
      >[];
      expect((data[0]!.remoteRef as Record<string, unknown>).key).toBe(
        'staging/services/session-hub/orders-db'
      );
    });

    test('a namespaced service keeps its namespace in the remote path', () => {
      // declared name `orders.session-hub` keys the path in full, so two
      // services sharing an own-name in different namespaces never collide.
      const plugin = createSecretBindingPlugin(STORE);
      const [file] = emit(plugin, manifestOf({ name: 'orders.session-hub', needs: ['orders-db'] }));
      const data = (parseYaml(file!.content).spec as Record<string, unknown>).data as Record<
        string,
        unknown
      >[];
      expect((data[0]!.remoteRef as Record<string, unknown>).key).toBe(
        'production/services/orders.session-hub/orders-db'
      );
      expect(parseYaml(file!.content).metadata).toMatchObject({
        name: 'orders-session-hub-orders-db',
      });
    });

    test('same own-name + need in two namespaces yields distinct files and paths', () => {
      const plugin = createSecretBindingPlugin(STORE);
      const files = emit(
        plugin,
        manifestOf({ name: 'orders.api', needs: ['db'] }, { name: 'billing.api', needs: ['db'] })
      );
      expect(files.length).toBe(2);
      expect(new Set(files.map((f) => f.path)).size).toBe(2);
      const keys = files.map((f) => {
        const data = (parseYaml(f.content).spec as Record<string, unknown>).data as Record<
          string,
          unknown
        >[];
        return (data[0]!.remoteRef as Record<string, unknown>).key as string;
      });
      expect(keys.sort()).toEqual([
        'production/services/billing.api/db',
        'production/services/orders.api/db',
      ]);
    });
  });

  // AC3 — configurable, backend-agnostic secret store reference
  describe('AC3: configurable backend-agnostic secretStoreRef', () => {
    test('renders the configured store name and kind', () => {
      const plugin = createSecretBindingPlugin({
        secretStoreRef: { name: 'vault-backend', kind: 'SecretStore' },
      });
      const [file] = emit(plugin, manifestOf({ name: 'svc', needs: ['db'] }));
      const ref = (parseYaml(file!.content).spec as Record<string, unknown>)
        .secretStoreRef as Record<string, unknown>;
      expect(ref).toMatchObject({ name: 'vault-backend', kind: 'SecretStore' });
    });

    test('a store name carrying YAML-special characters is emitted quoted', () => {
      const plugin = createSecretBindingPlugin({
        secretStoreRef: { name: 'store: with #specials' },
      });
      const [file] = emit(plugin, manifestOf({ name: 'svc', needs: ['db'] }));
      expect(file!.content).toContain('name: "store: with #specials"');
    });

    test('secretStoreRef kind defaults to ClusterSecretStore when omitted', () => {
      const plugin = createSecretBindingPlugin({ secretStoreRef: { name: 'gcp-sm' } });
      const [file] = emit(plugin, manifestOf({ name: 'svc', needs: ['db'] }));
      const ref = (parseYaml(file!.content).spec as Record<string, unknown>)
        .secretStoreRef as Record<string, unknown>;
      expect(ref).toMatchObject({ name: 'gcp-sm', kind: 'ClusterSecretStore' });
    });

    test('the plugin is backend-agnostic: store name is opaque, never validated', () => {
      const plugin = createSecretBindingPlugin({ secretStoreRef: { name: 'literally-anything' } });
      const [file] = emit(plugin, manifestOf({ name: 'svc', needs: ['db'] }));
      expect(file!.content).toContain('name: literally-anything');
    });
  });

  // AC5 — workload-identity annotation
  describe('AC5: supports a workload-identity annotation', () => {
    test('omitted by default — no annotations block when unconfigured', () => {
      const plugin = createSecretBindingPlugin(STORE);
      const [file] = emit(plugin, manifestOf({ name: 'svc', needs: ['db'] }));
      expect(file!.content).not.toContain('annotations:');
    });

    test('renders a configured workload-identity annotation on the ExternalSecret metadata', () => {
      const plugin = createSecretBindingPlugin({
        ...STORE,
        workloadIdentityAnnotation: {
          key: 'eks.amazonaws.com/role-arn',
          value: 'arn:aws:iam::123:role/session-hub',
        },
      });
      const [file] = emit(plugin, manifestOf({ name: 'session-hub', needs: ['orders-db'] }));
      expect(file!.content).toContain('annotations:');
      expect(file!.content).toContain(
        'eks.amazonaws.com/role-arn: arn:aws:iam::123:role/session-hub'
      );
    });
  });

  // AC6 — naming convention written once, applies to all services
  describe('AC6: operator writes the convention once; it applies to every service', () => {
    test('one plugin config governs every service & need uniformly', () => {
      const plugin = createSecretBindingPlugin(STORE);
      const files = emit(
        plugin,
        manifestOf({ name: 'alpha', needs: ['db'] }, { name: 'beta', needs: ['db'] })
      );
      const keys = files.map((f) => {
        const data = (parseYaml(f.content).spec as Record<string, unknown>).data as Record<
          string,
          unknown
        >[];
        return (data[0]!.remoteRef as Record<string, unknown>).key as string;
      });
      // identical convention, distinct service segments — no per-service config
      expect(keys.sort()).toEqual(['production/services/alpha/db', 'production/services/beta/db']);
    });
  });

  // Determinism (PRD/types Notes — generate must be pure & deterministic)
  describe('deterministic output', () => {
    test('same manifest + options yields byte-identical files in identical order', () => {
      const plugin = createSecretBindingPlugin(STORE);
      const m = manifestOf(
        { name: 'b-svc', needs: ['z-need', 'a-need'] },
        { name: 'a-svc', needs: ['db'] }
      );
      const a = emit(plugin, m);
      const b = emit(plugin, m);
      expect(a.map((f) => f.path)).toEqual(b.map((f) => f.path));
      expect(a.map((f) => f.content)).toEqual(b.map((f) => f.content));
    });

    test('files are emitted in a stable, sorted-by-path order', () => {
      const plugin = createSecretBindingPlugin(STORE);
      const files = emit(
        plugin,
        manifestOf({ name: 'b-svc', needs: ['z-need', 'a-need'] }, { name: 'a-svc', needs: ['db'] })
      );
      const paths = files.map((f) => f.path);
      expect([...paths].sort()).toEqual(paths);
    });

    test('refreshInterval defaults to 1h and is configurable', () => {
      const def = createSecretBindingPlugin(STORE);
      expect(emit(def, manifestOf({ name: 's', needs: ['db'] }))[0]!.content).toContain(
        'refreshInterval: 1h'
      );
      const custom = createSecretBindingPlugin({ ...STORE, refreshInterval: '30m' });
      expect(emit(custom, manifestOf({ name: 's', needs: ['db'] }))[0]!.content).toContain(
        'refreshInterval: 30m'
      );
    });
  });

  // Type-level contract guarantees
  describe('type contract', () => {
    test('createSecretBindingPlugin returns a GeneratorPlugin', () => {
      expectTypeOf(createSecretBindingPlugin).returns.toEqualTypeOf<GeneratorPlugin>();
    });

    test('secretStoreRef is required; workload identity & refresh are optional', () => {
      expectTypeOf<SecretBindingConfig>().toHaveProperty('secretStoreRef');
      expectTypeOf<SecretBindingConfig['secretStoreRef']>()
        .toHaveProperty('name')
        .toEqualTypeOf<string>();
      expectTypeOf<SecretBindingConfig['workloadIdentityAnnotation']>().toEqualTypeOf<
        { readonly key: string; readonly value: string } | undefined
      >();
      // secretStoreRef.kind is constrained to the external-secrets enum
      expectTypeOf<NonNullable<SecretBindingConfig['secretStoreRef']['kind']>>().toEqualTypeOf<
        'ClusterSecretStore' | 'SecretStore'
      >();
    });

    test('config rejects an unknown secretStoreRef kind', () => {
      // @ts-expect-error kind must be ClusterSecretStore | SecretStore
      const _bad: SecretBindingConfig = { secretStoreRef: { name: 'x', kind: 'Nonsense' } };
    });
  });
});
