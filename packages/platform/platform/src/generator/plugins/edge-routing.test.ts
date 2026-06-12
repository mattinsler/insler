import { describe, expect, test } from 'bun:test';

import { Contract } from '@insler/rpc/contract';
import { defineService } from '@insler/service';
import type { ExposeConfig } from '@insler/service';
import { expectTypeOf } from 'expect-type';
import { z } from 'zod';

import { buildFleetManifest } from '../../fleet/index.js';
import type { FleetManifest, FleetRoute } from '../../fleet/index.js';
import type { GeneratedFile, GeneratorOptions, GeneratorPlugin } from '../types.js';
import { edgeRoutingPlugin } from './edge-routing.js';
import type { EdgeRoute, EdgeRoutingTable } from './edge-routing.js';

// --- Test harness: build a real FleetManifest from the model only (no scanner) ---
//
// ADR-0002 boundary: the generator (and this plugin) consumes only the
// FleetManifest *model* from `@insler/platform/fleet`, never its filesystem scanner. We
// assemble manifests programmatically via `buildFleetManifest`.

interface ServiceSpec {
  readonly name: string;
  readonly methods: readonly string[];
  readonly expose?: ExposeConfig;
}

function defOf(spec: ServiceSpec) {
  const methods: Record<string, { input: z.ZodTypeAny; output: z.ZodTypeAny }> = {};
  for (const method of spec.methods) {
    methods[method] = { input: z.object({ x: z.string() }), output: z.object({ y: z.string() }) };
  }
  return {
    service: defineService({
      name: spec.name,
      kind: 'persistent',
      contract: Contract.create(spec.name, { version: '1.0.0', methods }),
      ...(spec.expose !== undefined ? { expose: spec.expose } : {}),
    }),
    file: `/virtual/${spec.name}.def.ts`,
  };
}

function manifestOf(...specs: readonly ServiceSpec[]): FleetManifest {
  const result = buildFleetManifest(specs.map(defOf));
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

/** Run the plugin and return its single emitted file. */
function generateOne(manifest: FleetManifest): GeneratedFile {
  const files = edgeRoutingPlugin.generate(manifest, OPTIONS);
  expect(files).toHaveLength(1);
  return files[0]!;
}

/** Parse the emitted artifact back into the structured routing table. */
function tableOf(manifest: FleetManifest): EdgeRoutingTable {
  return JSON.parse(generateOne(manifest).content) as EdgeRoutingTable;
}

// The example from the issue, as a manifest.
function exampleManifest(): FleetManifest {
  return manifestOf(
    {
      name: 'summarize',
      methods: ['summarize'],
      expose: { http: { method: 'POST', path: '/summary', stream: 'sse' } },
    },
    {
      name: 'orders',
      methods: ['create', 'get'],
      expose: {
        http: [
          { method: 'POST', path: '/orders', handler: 'create' },
          { method: 'GET', path: '/orders/:id', handler: 'get' },
        ],
      },
    }
  );
}

// --- AC1: collects expose blocks from all services ---

describe('edgeRoutingPlugin — collects expose blocks across all services (AC1)', () => {
  test('is a GeneratorPlugin with a stable name', () => {
    expect(edgeRoutingPlugin.name).toBe('edge-routing');
    expectTypeOf(edgeRoutingPlugin).toMatchTypeOf<GeneratorPlugin>();
  });

  test('gathers routes from every exposing service into one table', () => {
    const table = tableOf(exampleManifest());
    expect(table.routes.map((r) => r.service).sort()).toEqual(['orders', 'orders', 'summarize']);
    expect(table.routes).toHaveLength(3);
  });

  test('services with no expose block contribute no routes', () => {
    const table = tableOf(
      manifestOf(
        { name: 'internal-only', methods: ['run'] },
        {
          name: 'orders',
          methods: ['create'],
          expose: { http: { method: 'POST', path: '/orders', handler: 'create' } },
        }
      )
    );
    expect(table.routes.map((r) => r.service)).toEqual(['orders']);
  });

  test('an entirely internal fleet yields an empty (but present) routing table', () => {
    const table = tableOf(
      manifestOf({ name: 'a', methods: ['run'] }, { name: 'b', methods: ['run'] })
    );
    expect(table.routes).toEqual([]);
  });
});

// --- AC2: complete routing table with path, method, NATS subject mapping ---

describe('edgeRoutingPlugin — complete route entries with NATS subject mapping (AC2)', () => {
  test('matches the issue example exactly (method, path, service, handler, stream, natsSubject)', () => {
    const table = tableOf(exampleManifest());
    const byPath = new Map(table.routes.map((r) => [`${r.method ?? 'WS'} ${r.path}`, r]));

    // `transport` is carried alongside the issue example's fields so the edge
    // bridge (#0020) can distinguish HTTP from WebSocket without re-deriving it.
    expect(byPath.get('POST /summary')).toEqual({
      transport: 'http',
      method: 'POST',
      path: '/summary',
      service: 'summarize',
      handler: 'summarize',
      stream: 'sse',
      natsSubject: 'rpc.summarize.summarize',
    });
    expect(byPath.get('POST /orders')).toEqual({
      transport: 'http',
      method: 'POST',
      path: '/orders',
      service: 'orders',
      handler: 'create',
      natsSubject: 'rpc.orders.create',
    });
    expect(byPath.get('GET /orders/:id')).toEqual({
      transport: 'http',
      method: 'GET',
      path: '/orders/:id',
      service: 'orders',
      handler: 'get',
      natsSubject: 'rpc.orders.get',
    });
  });

  test('natsSubject is rpc.{service}.{handler}', () => {
    const table = tableOf(
      manifestOf({
        name: 'orders',
        methods: ['create'],
        expose: { http: { method: 'POST', path: '/orders', handler: 'create' } },
      })
    );
    expect(table.routes[0]!.natsSubject).toBe('rpc.orders.create');
  });

  test('handler defaults to the service name when the expose route names none', () => {
    // matches the issue: summarize service, single route, no handler -> rpc.summarize.summarize
    const table = tableOf(
      manifestOf({
        name: 'summarize',
        methods: ['summarize'],
        expose: { http: { method: 'POST', path: '/summary', stream: 'sse' } },
      })
    );
    const route = table.routes[0]!;
    expect(route.handler).toBe('summarize');
    expect(route.natsSubject).toBe('rpc.summarize.summarize');
  });

  test('every route carries a non-empty path, service, handler, and natsSubject', () => {
    const table = tableOf(exampleManifest());
    for (const route of table.routes) {
      expect(route.path.length).toBeGreaterThan(0);
      expect(route.service.length).toBeGreaterThan(0);
      expect(route.handler.length).toBeGreaterThan(0);
      expect(route.natsSubject).toBe(`rpc.${route.service}.${route.handler}`);
    }
  });
});

// --- AC3: validates no conflicting routes (same path + method, different services) ---

describe('edgeRoutingPlugin — conflict validation (AC3)', () => {
  // The fleet scanner (#0010) already rejects duplicate expose routes while
  // building a manifest, so a *valid* manifest can never carry a conflict. The
  // plugin re-asserts the invariant locally (defense in depth) so it can never
  // emit a self-conflicting table — exercised here by handing it a manifest
  // whose `expose.routes` were assembled directly, bypassing `buildFleetManifest`.
  function conflictingManifest(...routes: readonly FleetRoute[]): FleetManifest {
    return {
      services: [],
      graph: { edges: [] },
      expose: { routes },
    };
  }

  test('rejects two services claiming the same method + path', () => {
    const manifest = conflictingManifest(
      { transport: 'http', method: 'GET', path: '/thing', service: 'a', handler: 'run' },
      { transport: 'http', method: 'GET', path: '/thing', service: 'b', handler: 'run' }
    );
    expect(() => edgeRoutingPlugin.generate(manifest, OPTIONS)).toThrow(/conflict/i);
  });

  test('the conflict message names the path and both services', () => {
    const manifest = conflictingManifest(
      { transport: 'http', method: 'POST', path: '/dup', service: 'alpha', handler: 'run' },
      { transport: 'http', method: 'POST', path: '/dup', service: 'beta', handler: 'run' }
    );
    expect(() => edgeRoutingPlugin.generate(manifest, OPTIONS)).toThrow(/\/dup/);
    expect(() => edgeRoutingPlugin.generate(manifest, OPTIONS)).toThrow(/alpha/);
    expect(() => edgeRoutingPlugin.generate(manifest, OPTIONS)).toThrow(/beta/);
  });

  test('same path with different methods is NOT a conflict', () => {
    const table = tableOf(
      manifestOf({
        name: 'orders',
        methods: ['list', 'create'],
        expose: {
          http: [
            { method: 'GET', path: '/orders', handler: 'list' },
            { method: 'POST', path: '/orders', handler: 'create' },
          ],
        },
      })
    );
    expect(table.routes).toHaveLength(2);
  });

  test('a websocket route and an http route on the same path do not conflict', () => {
    const table = tableOf(
      manifestOf({
        name: 'chat',
        methods: ['poll', 'stream'],
        expose: {
          http: { method: 'GET', path: '/chat', handler: 'poll' },
          websocket: { path: '/chat', handler: 'stream' },
        },
      })
    );
    expect(table.routes).toHaveLength(2);
  });
});

// --- AC4: supports path parameters (:id style) ---

describe('edgeRoutingPlugin — path parameters (AC4)', () => {
  test('carries :id-style params through verbatim', () => {
    const table = tableOf(
      manifestOf({
        name: 'orders',
        methods: ['get'],
        expose: { http: { method: 'GET', path: '/orders/:id', handler: 'get' } },
      })
    );
    expect(table.routes[0]!.path).toBe('/orders/:id');
  });

  test('multiple params in one path are preserved', () => {
    const table = tableOf(
      manifestOf({
        name: 'nested',
        methods: ['get'],
        expose: { http: { method: 'GET', path: '/users/:userId/orders/:orderId', handler: 'get' } },
      })
    );
    expect(table.routes[0]!.path).toBe('/users/:userId/orders/:orderId');
  });
});

// --- AC5: supports streaming modes (SSE, WebSocket) ---

describe('edgeRoutingPlugin — streaming modes (AC5)', () => {
  test('an SSE-flavored HTTP route reports stream: sse', () => {
    const table = tableOf(
      manifestOf({
        name: 'feed',
        methods: ['watch'],
        expose: { http: { method: 'GET', path: '/feed', handler: 'watch', stream: 'sse' } },
      })
    );
    expect(table.routes[0]!.stream).toBe('sse');
  });

  test('a websocket expose becomes a route with transport websocket and stream: ws', () => {
    const table = tableOf(
      manifestOf({
        name: 'live',
        methods: ['socket'],
        expose: { websocket: { path: '/live', handler: 'socket' } },
      })
    );
    const route = table.routes[0]!;
    expect(route.transport).toBe('websocket');
    expect(route.stream).toBe('ws');
    expect(route.method).toBeUndefined();
    expect(route.natsSubject).toBe('rpc.live.socket');
  });

  test('a plain (non-streaming) HTTP route has no stream field', () => {
    const table = tableOf(
      manifestOf({
        name: 'orders',
        methods: ['create'],
        expose: { http: { method: 'POST', path: '/orders', handler: 'create' } },
      })
    );
    expect(table.routes[0]!.stream).toBeUndefined();
  });
});

// --- AC6: output format consumable by the edge bridge (#0020) ---

describe('edgeRoutingPlugin — output artifact (AC6)', () => {
  test('emits exactly one artifact', () => {
    const files = edgeRoutingPlugin.generate(exampleManifest(), OPTIONS);
    expect(files).toHaveLength(1);
  });

  test('the artifact is a structured JSON document with a top-level routes array', () => {
    const file = generateOne(exampleManifest());
    expect(file.format).toBe('json');
    const parsed = JSON.parse(file.content) as EdgeRoutingTable;
    expect(Array.isArray(parsed.routes)).toBe(true);
  });

  test('the artifact has a stable, predictable path', () => {
    const file = generateOne(exampleManifest());
    expect(file.path).toBe('edge/routing-table.json');
  });

  test('content is newline-terminated text (writeable verbatim)', () => {
    const file = generateOne(exampleManifest());
    expect(file.content.endsWith('\n')).toBe(true);
  });
});

// --- AC7 + Notes: deterministic output (stable ordering) ---

describe('edgeRoutingPlugin — determinism & one-service-one-edit (AC7, Notes)', () => {
  test('route order is stable regardless of service discovery order', () => {
    const a = tableOf(
      manifestOf(
        {
          name: 'zeta',
          methods: ['run'],
          expose: { http: { method: 'GET', path: '/z', handler: 'run' } },
        },
        {
          name: 'alpha',
          methods: ['run'],
          expose: { http: { method: 'POST', path: '/a', handler: 'run' } },
        }
      )
    );
    const b = tableOf(
      manifestOf(
        {
          name: 'alpha',
          methods: ['run'],
          expose: { http: { method: 'POST', path: '/a', handler: 'run' } },
        },
        {
          name: 'zeta',
          methods: ['run'],
          expose: { http: { method: 'GET', path: '/z', handler: 'run' } },
        }
      )
    );
    expect(a).toEqual(b);
  });

  test('routes are sorted by (path, method) for a meaningful diff', () => {
    const table = tableOf(
      manifestOf({
        name: 'svc',
        methods: ['a', 'b', 'c', 'd'],
        expose: {
          http: [
            { method: 'POST', path: '/b', handler: 'b' },
            { method: 'GET', path: '/b', handler: 'a' },
            { method: 'DELETE', path: '/a', handler: 'd' },
            { method: 'GET', path: '/a', handler: 'c' },
          ],
        },
      })
    );
    const keys = table.routes.map((r) => `${r.path} ${r.method ?? 'WS'}`);
    expect(keys).toEqual(['/a DELETE', '/a GET', '/b GET', '/b POST']);
  });

  test('the same manifest yields byte-identical content across runs', () => {
    const m = exampleManifest();
    expect(generateOne(m).content).toBe(generateOne(m).content);
  });

  test('adding a route to one service changes only that service’s entries (one-edit, AC7)', () => {
    const before = tableOf(
      manifestOf(
        {
          name: 'orders',
          methods: ['create'],
          expose: { http: { method: 'POST', path: '/orders', handler: 'create' } },
        },
        {
          name: 'users',
          methods: ['get'],
          expose: { http: { method: 'GET', path: '/users/:id', handler: 'get' } },
        }
      )
    );
    const after = tableOf(
      manifestOf(
        {
          name: 'orders',
          methods: ['create', 'get'],
          expose: {
            http: [
              { method: 'POST', path: '/orders', handler: 'create' },
              { method: 'GET', path: '/orders/:id', handler: 'get' },
            ],
          },
        },
        {
          name: 'users',
          methods: ['get'],
          expose: { http: { method: 'GET', path: '/users/:id', handler: 'get' } },
        }
      )
    );
    // the users route is untouched; only orders gained an entry
    const usersBefore = before.routes.filter((r) => r.service === 'users');
    const usersAfter = after.routes.filter((r) => r.service === 'users');
    expect(usersAfter).toEqual(usersBefore);
    expect(after.routes.filter((r) => r.service === 'orders')).toHaveLength(2);
  });
});

// --- Type-level contract (the artifact shape the edge bridge derives from) ---

describe('edgeRoutingPlugin — type contract', () => {
  test('EdgeRoute carries the documented fields with the documented optionality', () => {
    expectTypeOf<EdgeRoute>().toHaveProperty('path').toEqualTypeOf<string>();
    expectTypeOf<EdgeRoute>().toHaveProperty('service').toEqualTypeOf<string>();
    expectTypeOf<EdgeRoute>().toHaveProperty('handler').toEqualTypeOf<string>();
    expectTypeOf<EdgeRoute>().toHaveProperty('natsSubject').toEqualTypeOf<string>();
    expectTypeOf<EdgeRoute>().toHaveProperty('transport').toEqualTypeOf<'http' | 'websocket'>();
    expectTypeOf<EdgeRoute>()
      .toHaveProperty('method')
      .toEqualTypeOf<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | undefined>();
    expectTypeOf<EdgeRoute>().toHaveProperty('stream').toEqualTypeOf<'sse' | 'ws' | undefined>();
  });

  test('EdgeRoutingTable is a routes wrapper', () => {
    expectTypeOf<EdgeRoutingTable>().toHaveProperty('routes').toEqualTypeOf<readonly EdgeRoute[]>();
  });
});
