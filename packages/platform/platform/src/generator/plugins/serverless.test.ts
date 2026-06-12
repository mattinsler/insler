import { describe, expect, test } from 'bun:test';

import { Contract } from '@insler/rpc/contract';
import { defineService } from '@insler/service';
import type { ScaleConfig, ServiceDef, ServiceKind } from '@insler/service';
import { expectTypeOf } from 'expect-type';
import { z } from 'zod';

import { buildFleetManifest } from '../../fleet/index.js';
import type { FleetManifest } from '../../fleet/index.js';
import { createGenerator } from '../generator.js';
import type { GeneratedFile, GeneratorOptions, GeneratorPlugin } from '../types.js';
import {
  cloudRunPlatform,
  serverlessPlugin,
  type NatsConnectivity,
  type ServerlessConfig,
  type ServerlessPlatform,
  type ServerlessService,
} from './serverless.js';

// --- fixtures: real ServiceDefs folded into a real FleetManifest (no scanner) ---

interface SvcExtra {
  readonly kind?: ServiceKind;
  readonly needs?: readonly string[];
  readonly scale?: ScaleConfig;
}

function svc(name: string, extra: SvcExtra = {}): ServiceDef {
  const contract = Contract.create(name, {
    version: '1.0.0',
    methods: {
      run: { input: z.object({ x: z.string() }), output: z.object({ y: z.string() }) },
    },
  });
  const common = {
    name,
    contract,
    ...(extra.needs !== undefined ? { needs: extra.needs } : {}),
    ...(extra.scale !== undefined ? { scale: extra.scale } : {}),
  } as const;

  switch (extra.kind ?? 'persistent') {
    case 'ephemeral':
      return defineService({ ...common, kind: 'ephemeral' });
    case 'workflow':
      return defineService({ ...common, kind: 'workflow', taskQueue: `${name}-q` });
    default:
      return defineService({ ...common, kind: 'persistent' });
  }
}

function manifestOf(...services: readonly ServiceDef[]): FleetManifest {
  const scanned = services.map((service) => ({ service, file: `/virtual/${service.name}.def.ts` }));
  const result = buildFleetManifest(scanned);
  if (result.manifest === undefined) {
    throw new Error(`fixture manifest invalid: ${JSON.stringify(result.errors)}`);
  }
  return result.manifest;
}

const SERVERLESS: GeneratorOptions = {
  target: 'serverless',
  outputDir: '/unused',
  environment: 'prod',
};
const K8S: GeneratorOptions = { ...SERVERLESS, target: 'kubernetes' };

/** Parse the simple `key: value` and nested lines this plugin emits, for assertions. */
function emit(
  plugin: GeneratorPlugin,
  manifest: FleetManifest,
  options = SERVERLESS
): GeneratedFile[] {
  return createGenerator().use(plugin).generate(manifest, options).files as GeneratedFile[];
}

// --- AC1 / AC2: the plugin produces serverless deployment config for one platform ---

describe('serverlessPlugin — produces platform deployment config (AC1, AC2)', () => {
  test('emits one Cloud Run service artifact per service', () => {
    const files = emit(serverlessPlugin(), manifestOf(svc('orders'), svc('checkout')));
    expect(files.map((f) => f.path)).toEqual([
      'cloud-run/checkout.service.yaml',
      'cloud-run/orders.service.yaml',
    ]);
  });

  test('the artifact is a Knative/Cloud Run Service in yaml format', () => {
    const [file] = emit(serverlessPlugin(), manifestOf(svc('orders')));
    expect(file?.format).toBe('yaml');
    expect(file?.content).toContain('apiVersion: serving.knative.dev/v1');
    expect(file?.content).toContain('kind: Service');
    expect(file?.content).toContain('name: "orders"');
  });

  test('the target platform is swappable without changing the plugin (vendor deferred)', () => {
    const flyMachines: ServerlessPlatform = {
      id: 'fly-machines',
      minScaleFloor: 0,
      maxScaleCeiling: 50,
      render: (s) => [
        {
          path: `${flyMachines.id}/${s.name}.toml`,
          content: `app = "${s.name}"\n`,
          format: 'toml',
        },
      ],
    };
    const files = emit(serverlessPlugin({ platform: flyMachines }), manifestOf(svc('orders')));
    expect(files.map((f) => f.path)).toEqual(['fly-machines/orders.toml']);
    expect(files[0]?.format).toBe('toml');
    expect(files[0]?.content).toContain('app = "orders"');
  });
});

// --- AC3: same ServiceDef produces both K8s and serverless artifacts ---

describe('dual-target — same ServiceDef drives K8s and serverless (AC3)', () => {
  test('the serverless plugin emits only for the serverless target', () => {
    const manifest = manifestOf(svc('orders'));
    expect(emit(serverlessPlugin(), manifest, SERVERLESS).length).toBeGreaterThan(0);
    expect(emit(serverlessPlugin(), manifest, K8S)).toEqual([]);
  });

  test('serverless coexists with a K8s-style plugin on one engine for the serverless run', () => {
    // A stand-in K8s plugin (real #0012 does not exist yet) that consumes the
    // SAME ServiceDef. The two targets compose without path collision.
    const k8sLike: GeneratorPlugin = {
      name: 'kubernetes',
      generate: (m) =>
        m.services.map((s) => ({
          path: `kubernetes/${s.name}.deployment.yaml`,
          content: `kind: Deployment\nmetadata:\n  name: ${s.name}\n`,
          format: 'yaml' as const,
        })),
    };
    const manifest = manifestOf(svc('orders'));
    const result = createGenerator()
      .use(k8sLike, serverlessPlugin())
      .generate(manifest, SERVERLESS);
    expect(result.files.map((f) => f.path)).toEqual([
      'cloud-run/orders.service.yaml',
      'kubernetes/orders.deployment.yaml',
    ]);
  });

  test('one declaration produces a serverless artifact and a K8s artifact from the same source', () => {
    const orders = svc('orders');
    const k8sLike: GeneratorPlugin = {
      name: 'kubernetes',
      generate: (m) =>
        m.services.map((s) => ({
          path: `kubernetes/${s.name}.yaml`,
          content: `name: ${s.name}\n`,
          format: 'yaml' as const,
        })),
    };
    const serverlessFiles = emit(serverlessPlugin(), manifestOf(orders), SERVERLESS);
    const k8sFiles = emit(k8sLike, manifestOf(orders), K8S);
    expect(serverlessFiles[0]?.path).toBe('cloud-run/orders.service.yaml');
    expect(k8sFiles[0]?.path).toBe('kubernetes/orders.yaml');
  });
});

// --- AC4: NATS connectivity configured (leaf node or direct) ---

describe('NATS connectivity (AC4)', () => {
  test('defaults to a leaf-node connection (SaaS-plane default)', () => {
    const [file] = emit(serverlessPlugin(), manifestOf(svc('orders')));
    expect(file?.content).toContain('name: NATS_CONNECTIVITY');
    expect(file?.content).toContain('value: "leaf-node"');
    expect(file?.content).toContain('name: NATS_URL');
  });

  test('direct connectivity is configurable', () => {
    const [file] = emit(
      serverlessPlugin({ natsConnectivity: 'direct', natsUrl: 'nats://cluster:4222' }),
      manifestOf(svc('orders'))
    );
    expect(file?.content).toContain('value: "direct"');
    expect(file?.content).toContain('value: "nats://cluster:4222"');
  });

  test('a custom leaf-node url overrides the default', () => {
    const [file] = emit(
      serverlessPlugin({ natsConnectivity: 'leaf-node', natsUrl: 'nats://10.0.0.1:4222' }),
      manifestOf(svc('orders'))
    );
    expect(file?.content).toContain('value: "nats://10.0.0.1:4222"');
  });
});

// --- AC5: scale min/max respected within platform constraints ---

describe('scale min/max within platform constraints (AC5)', () => {
  function scaleOf(content: string): { min: string | undefined; max: string | undefined } {
    const min = content.match(/minScale: "(\d+)"/)?.[1];
    const max = content.match(/maxScale: "(\d+)"/)?.[1];
    return { min, max };
  }

  test('a declared scale window is honored verbatim when it fits the platform', () => {
    const [file] = emit(
      serverlessPlugin(),
      manifestOf(svc('orders', { kind: 'persistent', scale: { on: 'cpu', min: 2, max: 8 } }))
    );
    expect(scaleOf(file?.content ?? '')).toEqual({ min: '2', max: '8' });
  });

  test('ephemeral scale-to-zero (min 0) is preserved on a platform that allows it', () => {
    const [file] = emit(
      serverlessPlugin(),
      manifestOf(
        svc('worker', { kind: 'ephemeral', scale: { on: 'queue-depth', min: 0, max: 50 } })
      )
    );
    expect(scaleOf(file?.content ?? '')).toEqual({ min: '0', max: '50' });
  });

  test('persistent default floor is at least 1 when no scale declared', () => {
    const [file] = emit(serverlessPlugin(), manifestOf(svc('api', { kind: 'persistent' })));
    expect(scaleOf(file?.content ?? '').min).toBe('1');
  });

  test('a declared max above the platform ceiling is clamped down (never dropped)', () => {
    const tinyPlatform: ServerlessPlatform = { ...cloudRunPlatform, maxScaleCeiling: 10 };
    const [file] = emit(
      serverlessPlugin({ platform: tinyPlatform }),
      manifestOf(svc('orders', { kind: 'persistent', scale: { on: 'cpu', min: 2, max: 8000 } }))
    );
    expect(scaleOf(file?.content ?? '')).toEqual({ min: '2', max: '10' });
  });

  test('a min below the platform floor is clamped up to the floor', () => {
    // A platform that forbids scale-to-zero (floor 1); an ephemeral min:0 clamps to 1.
    const noZero: ServerlessPlatform = { ...cloudRunPlatform, minScaleFloor: 1 };
    const [file] = emit(
      serverlessPlugin({ platform: noZero }),
      manifestOf(svc('worker', { kind: 'ephemeral', scale: { on: 'queue-depth', min: 0, max: 5 } }))
    );
    expect(scaleOf(file?.content ?? '').min).toBe('1');
  });
});

// --- AC6: secret binding adapted to the platform's secret management ---

describe('secret binding adapted to platform secret management (AC6)', () => {
  test('each logical need becomes a secret-backed env reference', () => {
    const [file] = emit(
      serverlessPlugin(),
      manifestOf(svc('session-hub', { needs: ['orders-db', 'valkey'] }))
    );
    const content = file?.content ?? '';
    // Cloud Run Secret Manager-backed env: secretKeyRef.name is the secret
    // resource (the #0015 convention path); secretKeyRef.key is the version.
    expect(content).toContain('secretKeyRef');
    expect(content).toContain('name: "prod/services/session-hub/orders-db"');
    expect(content).toContain('name: "prod/services/session-hub/valkey"');
    expect(content).toContain('key: latest');
    expect(content).not.toContain('name: latest');
    expect(content).toContain('name: ORDERS_DB');
    expect(content).toContain('name: VALKEY');
    // Field roles, not just string presence: the ref block binds name → path,
    // key → version, in that shape.
    expect(content).toContain(
      [
        '                secretKeyRef:',
        '                  name: "prod/services/session-hub/orders-db"',
        '                  key: latest',
      ].join('\n')
    );
  });

  test('a need starting with a digit yields a valid env identifier', () => {
    const [file] = emit(serverlessPlugin(), manifestOf(svc('auth', { needs: ['2fa-secret'] })));
    expect(file?.content).toContain('name: _2FA_SECRET');
  });

  test('a service with no needs emits no secret bindings', () => {
    const [file] = emit(serverlessPlugin(), manifestOf(svc('stateless')));
    expect(file?.content).not.toContain('secretKeyRef');
  });

  test('secret paths use the run environment', () => {
    const [file] = emit(serverlessPlugin(), manifestOf(svc('orders', { needs: ['orders-db'] })), {
      ...SERVERLESS,
      environment: 'staging',
    });
    expect(file?.content).toContain('name: "staging/services/orders/orders-db"');
  });
});

// --- Notes: deterministic output ---

describe('deterministic output (Notes)', () => {
  test('same manifest + options yields byte-identical output regardless of service order', () => {
    const a = emit(
      serverlessPlugin(),
      manifestOf(svc('orders', { needs: ['b', 'a'] }), svc('checkout'))
    );
    const b = emit(
      serverlessPlugin(),
      manifestOf(svc('checkout'), svc('orders', { needs: ['b', 'a'] }))
    );
    expect(a.map((f) => ({ path: f.path, content: f.content }))).toEqual(
      b.map((f) => ({ path: f.path, content: f.content }))
    );
  });

  test('files come back path-sorted', () => {
    const files = emit(serverlessPlugin(), manifestOf(svc('z'), svc('a'), svc('m')));
    const paths = files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
  });
});

// --- types ---

describe('serverless types', () => {
  test('serverlessPlugin returns a GeneratorPlugin; config + platform are typed', () => {
    expectTypeOf(serverlessPlugin).returns.toEqualTypeOf<GeneratorPlugin>();
    expectTypeOf<ServerlessConfig['platform']>().toEqualTypeOf<ServerlessPlatform | undefined>();
    expectTypeOf<NatsConnectivity>().toEqualTypeOf<'leaf-node' | 'direct'>();
    expectTypeOf<ServerlessPlatform['render']>().returns.toEqualTypeOf<readonly GeneratedFile[]>();
    expectTypeOf<ServerlessService['minScale']>().toEqualTypeOf<number>();
  });

  test('the default config is callable with no arguments', () => {
    expectTypeOf(serverlessPlugin).toBeCallableWith();
    // scale carried into the fixture is the real ScaleConfig shape
    expectTypeOf<ScaleConfig['on']>().toEqualTypeOf<
      'queue-depth' | 'cpu' | 'task-queue-backlog' | 'rps' | 'custom'
    >();
  });
});
