import { describe, expect, test } from 'bun:test';

import { Contract } from '@insler/rpc/contract';
import { defineService } from '@insler/service';
import { expectTypeOf } from 'expect-type';
import { z } from 'zod';

import { buildFleetManifest } from '../../fleet/index.js';
import type { FleetManifest } from '../../fleet/index.js';
import type { GeneratedFile, GeneratorOptions, GeneratorPlugin } from '../types.js';
import { dataStoreClaimsPlugin } from './data-store-claims.js';
import type { DataStoreClaimsConfig, DataStoreTypeDefaults } from './data-store-claims.js';

// --- shared fixtures: a real FleetManifest built from the model only (no scanner) ---

/**
 * Build a manifest where each entry is a service plus the logical needs it
 * declares. Needs become `needs` edges in `manifest.graph` — the only input the
 * plugin reads.
 */
function manifestOf(
  ...services: readonly { name: string; needs?: readonly string[] }[]
): FleetManifest {
  const scanned = services.map(({ name, needs }) => ({
    service: defineService({
      name,
      kind: 'persistent',
      ...(needs !== undefined ? { needs } : {}),
      contract: Contract.create(name, {
        version: '1.0.0',
        methods: {
          run: { input: z.object({ x: z.string() }), output: z.object({ y: z.string() }) },
        },
      }),
    }),
    file: `/virtual/${name}.def.ts`,
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

/** Parse a generated YAML-ish claim block into a flat key/value probe by line. */
function lineWith(content: string, needle: string): string | undefined {
  return content.split('\n').find((l) => l.includes(needle));
}

// --- AC1: detect unbound needs (no existing instance registered) ---

describe('unbound-need detection (AC1)', () => {
  test('a need with no registered instance is unbound; auto-provision emits a claim for it', () => {
    const plugin = dataStoreClaimsPlugin({ provision: 'auto' });
    const files = plugin.generate(manifestOf({ name: 'orders', needs: ['orders-db'] }), OPTIONS);

    expect(files.map((f) => f.path)).toEqual(['data-store-claims/orders-db.yaml']);
  });

  test('a need is detected once even when several services declare it', () => {
    const plugin = dataStoreClaimsPlugin({ provision: 'auto' });
    const files = plugin.generate(
      manifestOf(
        { name: 'orders', needs: ['shared-db'] },
        { name: 'billing', needs: ['shared-db'] }
      ),
      OPTIONS
    );

    expect(files.map((f) => f.path)).toEqual(['data-store-claims/shared-db.yaml']);
  });

  test('a manifest with no needs produces no files', () => {
    const plugin = dataStoreClaimsPlugin({ provision: 'auto' });
    expect(plugin.generate(manifestOf({ name: 'orders' }), OPTIONS)).toEqual([]);
  });
});

// --- AC2: produces Crossplane-compatible resource claims ---

describe('Crossplane-compatible claims (AC2)', () => {
  test('emits a claim carrying apiVersion / kind / metadata.name / spec', () => {
    const plugin = dataStoreClaimsPlugin({ provision: 'auto' });
    const [file] = plugin.generate(manifestOf({ name: 'orders', needs: ['orders-db'] }), OPTIONS);

    expect(file?.format).toBe('yaml');
    const content = file?.content ?? '';
    expect(content).toContain('apiVersion: database.crossplane.io/v1alpha1');
    expect(content).toContain('kind: PostgreSQLInstance');
    expect(lineWith(content, 'name: orders-db')).toBeDefined();
    expect(content).toContain('spec:');
    expect(content).toContain('compositionRef:');
  });
});

// --- AC3: default resource parameters configurable per data store type ---

describe('per-type default parameters (AC3)', () => {
  test('built-in postgres defaults are emitted when no override is given', () => {
    const plugin = dataStoreClaimsPlugin({ provision: 'auto' });
    const [file] = plugin.generate(manifestOf({ name: 'orders', needs: ['orders-db'] }), OPTIONS);
    const content = file?.content ?? '';

    expect(content).toContain('storageGB: 20');
    expect(content).toContain('version: "16"');
  });

  test('an operator can configure defaults per data store type, overriding built-ins', () => {
    const big: DataStoreTypeDefaults = {
      apiVersion: 'database.crossplane.io/v1alpha1',
      kind: 'PostgreSQLInstance',
      compositionRef: 'production-postgres',
      parameters: { storageGB: 200, version: '16' },
    };
    const plugin = dataStoreClaimsPlugin({
      provision: 'auto',
      dataStoreTypes: { 'analytics-db': big },
    });
    const [file] = plugin.generate(
      manifestOf({ name: 'reports', needs: ['analytics-db'] }),
      OPTIONS
    );
    const content = file?.content ?? '';

    expect(content).toContain('storageGB: 200');
    expect(content).toContain('compositionRef:');
    expect(lineWith(content, 'name: production-postgres')).toBeDefined();
  });

  test('a need with no matching type config and no default type surfaces as a plan error, not a guessed claim', () => {
    // 'redis-cache' has no built-in default and no override → cannot be safely provisioned.
    const plugin = dataStoreClaimsPlugin({ provision: 'auto' });
    const files = plugin.generate(
      manifestOf({ name: 'sessions', needs: ['redis-cache'] }),
      OPTIONS
    );

    expect(files.map((f) => f.path)).toEqual(['data-store-claims/plan-errors.yaml']);
    expect(files[0]?.content).toContain('redis-cache');
  });
});

// --- AC4: generated secret reference feeds the secret-binding pipeline (#0015) ---

describe('connection-secret reference for #0015 (AC4)', () => {
  test('claim writes its connection secret to a ref named after the logical need', () => {
    const plugin = dataStoreClaimsPlugin({ provision: 'auto' });
    const [file] = plugin.generate(manifestOf({ name: 'orders', needs: ['orders-db'] }), OPTIONS);
    const content = file?.content ?? '';

    expect(content).toContain('writeConnectionSecretToRef:');
    // the secret name is the logical need name — the convention #0015 binds on.
    const refBlock = content.slice(content.indexOf('writeConnectionSecretToRef:'));
    expect(lineWith(refBlock, 'name: orders-db')).toBeDefined();
  });

  test('the connection-secret namespace is configurable (defaults to services)', () => {
    const def = dataStoreClaimsPlugin({ provision: 'auto' });
    const [defFile] = def.generate(manifestOf({ name: 'orders', needs: ['orders-db'] }), OPTIONS);
    expect(defFile?.content ?? '').toContain('namespace: services');

    const custom = dataStoreClaimsPlugin({ provision: 'auto', secretNamespace: 'data' });
    const [customFile] = custom.generate(
      manifestOf({ name: 'orders', needs: ['orders-db'] }),
      OPTIONS
    );
    expect(customFile?.content ?? '').toContain('namespace: data');
  });
});

// --- AC5 + Notes: never provisions a store that should be managed externally; default is bind ---

describe('default-to-bind, never auto-provision externally-managed stores (AC5, Notes)', () => {
  test('default policy does NOT emit provisioning claims', () => {
    const plugin = dataStoreClaimsPlugin();
    const files = plugin.generate(manifestOf({ name: 'orders', needs: ['orders-db'] }), OPTIONS);

    const claimPaths = files.filter((f) => f.path.endsWith('orders-db.yaml'));
    expect(claimPaths).toEqual([]);
  });

  test('under the default policy an unbound need surfaces as a plan error, not an auto-provision', () => {
    const plugin = dataStoreClaimsPlugin();
    const files = plugin.generate(manifestOf({ name: 'orders', needs: ['orders-db'] }), OPTIONS);

    expect(files.map((f) => f.path)).toEqual(['data-store-claims/plan-errors.yaml']);
    expect(files[0]?.content).toContain('orders-db');
    expect(files[0]?.content?.toLowerCase()).toContain('unbound');
  });

  test('a registered need produces neither a claim nor a plan error under the default policy', () => {
    const plugin = dataStoreClaimsPlugin({ registered: ['orders-db'] });
    const files = plugin.generate(manifestOf({ name: 'orders', needs: ['orders-db'] }), OPTIONS);

    expect(files).toEqual([]);
  });
});

// --- AC6: platform operator can register existing instances to prevent auto-provisioning ---

describe('registered instances prevent auto-provisioning (AC6)', () => {
  test('a registered need is never provisioned even under auto policy', () => {
    const plugin = dataStoreClaimsPlugin({ provision: 'auto', registered: ['orders-db'] });
    const files = plugin.generate(
      manifestOf(
        { name: 'orders', needs: ['orders-db'] },
        { name: 'reports', needs: ['analytics-db'] }
      ),
      OPTIONS
    );

    // only the unregistered analytics-db is provisioned; orders-db is bound to the existing instance.
    expect(files.map((f) => f.path)).not.toContain('data-store-claims/orders-db.yaml');
  });

  test('registering every declared need yields no output at all', () => {
    const plugin = dataStoreClaimsPlugin({
      provision: 'auto',
      registered: ['orders-db', 'analytics-db'],
    });
    const files = plugin.generate(
      manifestOf(
        { name: 'orders', needs: ['orders-db'] },
        { name: 'reports', needs: ['analytics-db'] }
      ),
      OPTIONS
    );

    expect(files).toEqual([]);
  });
});

// --- Notes: deterministic output ---

describe('deterministic output (Notes)', () => {
  test('claims are emitted in stable, path-sorted order regardless of service/need order', () => {
    const plugin = dataStoreClaimsPlugin({
      provision: 'auto',
      dataStoreTypes: {
        'a-db': {
          apiVersion: 'database.crossplane.io/v1alpha1',
          kind: 'PostgreSQLInstance',
          compositionRef: 'production-postgres',
          parameters: { storageGB: 20, version: '16' },
        },
        'z-db': {
          apiVersion: 'database.crossplane.io/v1alpha1',
          kind: 'PostgreSQLInstance',
          compositionRef: 'production-postgres',
          parameters: { storageGB: 20, version: '16' },
        },
      },
    });
    const a = plugin.generate(
      manifestOf({ name: 's1', needs: ['z-db', 'a-db'] }, { name: 's2', needs: ['a-db'] }),
      OPTIONS
    );
    const b = plugin.generate(
      manifestOf({ name: 's2', needs: ['a-db'] }, { name: 's1', needs: ['a-db', 'z-db'] }),
      OPTIONS
    );

    const pathsA = a.map((f) => f.path);
    expect(pathsA).toEqual(b.map((f) => f.path));
    expect(pathsA).toEqual([...pathsA].sort());
    // identical content for identical input.
    expect(a.map((f) => f.content)).toEqual(b.map((f) => f.content));
  });
});

// --- types ---

describe('data-store-claims plugin types', () => {
  test('the factory returns a GeneratorPlugin', () => {
    expectTypeOf(dataStoreClaimsPlugin).returns.toEqualTypeOf<GeneratorPlugin>();
  });

  test('config is fully optional (an operator may pass nothing)', () => {
    expectTypeOf<DataStoreClaimsConfig>().toMatchTypeOf<object>();
    // calling with no args must compile.
    expectTypeOf<() => GeneratorPlugin>().toMatchTypeOf<typeof dataStoreClaimsPlugin>();
  });

  test('provision policy is the closed set bind | auto', () => {
    expectTypeOf<DataStoreClaimsConfig['provision']>().toEqualTypeOf<'bind' | 'auto' | undefined>();
  });

  test('generate is pure: GeneratedFile[] out', () => {
    const plugin = dataStoreClaimsPlugin();
    expectTypeOf(plugin.generate).returns.toEqualTypeOf<readonly GeneratedFile[]>();
  });
});
