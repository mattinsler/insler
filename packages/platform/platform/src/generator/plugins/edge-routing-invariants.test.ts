import { describe, expect, test } from 'bun:test';

import { Contract } from '@insler/rpc/contract';
import { defineService } from '@insler/service';
import type { ExposeConfig } from '@insler/service';
import { z } from 'zod';

import { buildFleetManifest } from '../../fleet/index.js';
import type { FleetManifest, FleetRoute } from '../../fleet/index.js';
import type { GeneratedFile, GeneratorOptions } from '../types.js';
import { edgeRoutingPlugin } from './edge-routing.js';
import type { EdgeRoutingTable } from './edge-routing.js';

/**
 * Edge routing cross-cutting / invariant tests (#0029).
 *
 * 0014 (`edge-routing.test.ts`) already exercises each acceptance criterion of
 * the routing-derivation plugin in isolation (table shape, conflict detection,
 * path params, streaming modes, determinism). This suite adds the *cross-cutting*
 * coverage #0029 names: a single realistic manifest with multiple `expose` blocks
 * across multiple services that exercises table generation, path conflicts, path
 * parameters, and both streaming modes *together*, plus property-style invariants
 * over the derived table. It deliberately does not re-assert 0014's per-AC unit
 * cases.
 *
 * Seam (ADR-0002 / conventions "Unit"): we drive the `edgeRoutingPlugin`
 * directly, consuming only the `FleetManifest` *model* from `@insler/platform/fleet` —
 * never the filesystem scanner.
 */

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

function generateOne(manifest: FleetManifest): GeneratedFile {
  const files = edgeRoutingPlugin.generate(manifest, OPTIONS);
  expect(files).toHaveLength(1);
  return files[0]!;
}

function tableOf(manifest: FleetManifest): EdgeRoutingTable {
  return JSON.parse(generateOne(manifest).content) as EdgeRoutingTable;
}

/**
 * A realistic fleet that touches every routing facet at once: plain HTTP, an
 * HTTP/SSE stream, a WebSocket, a path parameter, two services sharing a path
 * under different methods, and a WebSocket sharing a path with an HTTP route.
 */
function richManifest(): FleetManifest {
  return manifestOf(
    {
      name: 'orders',
      methods: ['list', 'create', 'get'],
      expose: {
        http: [
          { method: 'GET', path: '/orders', handler: 'list' },
          { method: 'POST', path: '/orders', handler: 'create' },
          { method: 'GET', path: '/orders/:id', handler: 'get' },
        ],
      },
    },
    {
      name: 'summarize',
      methods: ['summarize'],
      expose: { http: { method: 'POST', path: '/summary', stream: 'sse' } },
    },
    {
      name: 'chat',
      methods: ['history', 'live'],
      expose: {
        http: { method: 'GET', path: '/chat', handler: 'history' },
        websocket: { path: '/chat', handler: 'live' },
      },
    }
  );
}

// --- Cross-cutting: one manifest exercises every facet at once (AC1–AC5) ---

describe('edge routing — combined multi-service manifest (#0029)', () => {
  test('derives a complete table covering all facets from many expose blocks', () => {
    const table = tableOf(richManifest());
    const keyed = new Map(
      table.routes.map((r) => [`${r.transport}:${r.method ?? 'WS'}:${r.path}`, r])
    );

    // plain HTTP
    expect(keyed.get('http:GET:/orders')).toMatchObject({
      service: 'orders',
      handler: 'list',
      natsSubject: 'rpc.orders.list',
    });
    // path parameter carried verbatim (AC4)
    expect(keyed.get('http:GET:/orders/:id')?.path).toBe('/orders/:id');
    // HTTP/SSE stream (AC5) with handler defaulted to the service name
    expect(keyed.get('http:POST:/summary')).toMatchObject({
      stream: 'sse',
      handler: 'summarize',
      natsSubject: 'rpc.summarize.summarize',
    });
    // WebSocket (AC5): no method, stream ws
    expect(keyed.get('websocket:WS:/chat')).toMatchObject({
      transport: 'websocket',
      stream: 'ws',
      handler: 'live',
    });
    expect(keyed.get('websocket:WS:/chat')?.method).toBeUndefined();

    // every declared route is present exactly once:
    // 3 orders (list/create/get) + 1 summarize + chat HTTP + chat WS = 6
    expect(table.routes).toHaveLength(6);
  });

  test('every emitted route satisfies the natsSubject = rpc.{service}.{handler} invariant', () => {
    const table = tableOf(richManifest());
    for (const route of table.routes) {
      expect(route.natsSubject).toBe(`rpc.${route.service}.${route.handler}`);
    }
  });

  test('no two HTTP routes in the derived table share a (method, path) — invariant', () => {
    const table = tableOf(richManifest());
    const httpKeys = table.routes
      .filter((r) => r.transport === 'http')
      .map((r) => `${r.method} ${r.path}`);
    expect(new Set(httpKeys).size).toBe(httpKeys.length);
  });

  test('HTTP and WebSocket may legitimately co-exist on the same path', () => {
    const table = tableOf(richManifest());
    const onChat = table.routes.filter((r) => r.path === '/chat');
    expect(onChat.map((r) => r.transport).sort()).toEqual(['http', 'websocket']);
  });
});

// --- Cross-cutting: conflict detection from MULTIPLE services (AC3) ---

describe('edge routing — cross-service conflict detection (#0029 AC3)', () => {
  // A manifest whose expose.routes are assembled directly (bypassing the
  // scanner's own dedupe) so the plugin's local re-assertion is what fails.
  function rawManifest(...routes: readonly FleetRoute[]): FleetManifest {
    return { services: [], graph: { edges: [] }, expose: { routes } };
  }

  test('two different services claiming the same method+path is a clear, named error', () => {
    const manifest = rawManifest(
      { transport: 'http', method: 'GET', path: '/shared', service: 'svc-a', handler: 'run' },
      { transport: 'http', method: 'GET', path: '/shared', service: 'svc-b', handler: 'run' }
    );
    let caught: Error | undefined;
    try {
      edgeRoutingPlugin.generate(manifest, OPTIONS);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    // clear: names the path AND both conflicting services
    expect(caught!.message).toContain('/shared');
    expect(caught!.message).toContain('svc-a');
    expect(caught!.message).toContain('svc-b');
  });

  test('a conflict buried among many valid cross-service routes is still caught', () => {
    const manifest = rawManifest(
      { transport: 'http', method: 'GET', path: '/a', service: 'a', handler: 'run' },
      { transport: 'http', method: 'POST', path: '/b', service: 'b', handler: 'run' },
      { transport: 'http', method: 'PUT', path: '/dup', service: 'c', handler: 'run' },
      { transport: 'http', method: 'PUT', path: '/dup', service: 'd', handler: 'run' },
      { transport: 'http', method: 'DELETE', path: '/e', service: 'e', handler: 'run' }
    );
    expect(() => edgeRoutingPlugin.generate(manifest, OPTIONS)).toThrow(/\/dup/);
  });
});
