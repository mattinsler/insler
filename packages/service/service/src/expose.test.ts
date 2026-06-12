import { describe, expect, test } from 'bun:test';

import { expectTypeOf } from 'expect-type';

import {
  type ExposeConfig,
  type ExposeRoute,
  type HttpExpose,
  type HttpExposeRoute,
  type HttpMethod,
  type StreamMode,
  type WebsocketExpose,
  type WebsocketExposeRoute,
  collectExposeRouteIssues,
  toExposeRoutes,
  validateExpose,
  validateExposeRoutes,
} from './expose.js';
import * as index from './index.js';

// Issue 0007 — External transport annotations (expose).
//
// Scope of THIS layer (the expose declaration model):
//   AC1 — `expose` accepted in `defineService` with typed transport options   (define-service.test.ts + here)
//   AC2 — HTTP expose supports method, path, handler (method name), stream     (this file + define-service.test.ts)
//   AC3 — WebSocket expose supported as a transport option                     (this file)
//   AC4 — expose blocks are EXTRACTABLE as routes for routing-table derivation (this file: toExposeRoutes)
//   AC5 — exposed paths are unique across all services (no conflicts)          (this file: validateExposeRoutes)
//   AC6 — expose does not affect the service's kind or NATS behavior           (define-service.test.ts)
//
// Downstream (owned by their named issues, gated on #0007 — NOT built here):
//   AC4 (synthesis) — the generator collects every service's expose block and
//                     synthesizes the single edge gateway routing table   -> #0014
//   AC5 (wiring)    — running validateExposeRoutes over the whole fleet during
//                     static analysis                                     -> #0014
//   the edge bridge that translates external transport <-> NATS at runtime -> #0020

// --- AC2 / AC3: the typed option model ---

describe('HttpExpose / WebsocketExpose typed options', () => {
  test('HttpExpose carries method, path, optional handler & stream (type level, AC2)', () => {
    expectTypeOf<HttpExpose>().toHaveProperty('method').toEqualTypeOf<HttpMethod>();
    expectTypeOf<HttpExpose>().toHaveProperty('path').toEqualTypeOf<string>();
    expectTypeOf<HttpExpose>().toHaveProperty('handler').toEqualTypeOf<string | undefined>();
    expectTypeOf<HttpExpose>().toHaveProperty('stream').toEqualTypeOf<StreamMode | undefined>();
  });

  test('HttpMethod enumerates the supported verbs (type level, AC2)', () => {
    expectTypeOf<HttpMethod>().toEqualTypeOf<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'>();
  });

  test('stream mode is sse | ws (type level, AC2)', () => {
    expectTypeOf<StreamMode>().toEqualTypeOf<'sse' | 'ws'>();
  });

  test('WebsocketExpose carries a path and optional handler (type level, AC3)', () => {
    expectTypeOf<WebsocketExpose>().toHaveProperty('path').toEqualTypeOf<string>();
    expectTypeOf<WebsocketExpose>().toHaveProperty('handler').toEqualTypeOf<string | undefined>();
  });

  test('ExposeConfig accepts a single http route, a list, and/or a websocket (type level, AC1/AC3)', () => {
    expectTypeOf<{ http: HttpExpose }>().toMatchTypeOf<ExposeConfig>();
    expectTypeOf<{ http: readonly HttpExpose[] }>().toMatchTypeOf<ExposeConfig>();
    expectTypeOf<{ websocket: WebsocketExpose }>().toMatchTypeOf<ExposeConfig>();
    expectTypeOf<{ http: HttpExpose; websocket: WebsocketExpose }>().toMatchTypeOf<ExposeConfig>();
    // empty config is valid — internal-only service
    expectTypeOf<Record<string, never>>().toMatchTypeOf<ExposeConfig>();
  });
});

// --- AC4: extraction of expose blocks into a flat route list ---

describe('toExposeRoutes — flatten expose into the routing-table input (AC4)', () => {
  test('a single http route flattens to one http ExposeRoute', () => {
    const routes = toExposeRoutes({ http: { method: 'POST', path: '/summary', stream: 'sse' } });
    expect(routes).toEqual([
      { transport: 'http', method: 'POST', path: '/summary', stream: 'sse' },
    ]);
  });

  test('a list of http routes flattens to one ExposeRoute each, carrying handler', () => {
    const routes = toExposeRoutes({
      http: [
        { method: 'POST', path: '/orders', handler: 'create' },
        { method: 'GET', path: '/orders/:id', handler: 'get' },
      ],
    });
    expect(routes).toEqual([
      { transport: 'http', method: 'POST', path: '/orders', handler: 'create' },
      { transport: 'http', method: 'GET', path: '/orders/:id', handler: 'get' },
    ]);
  });

  test('a websocket endpoint flattens to a websocket ExposeRoute with no method (AC3/AC4)', () => {
    const routes = toExposeRoutes({ websocket: { path: '/live', handler: 'subscribe' } });
    expect(routes).toEqual([{ transport: 'websocket', path: '/live', handler: 'subscribe' }]);
    expect(routes[0]).not.toHaveProperty('method');
  });

  test('http routes and a websocket endpoint flatten together', () => {
    const routes = toExposeRoutes({
      http: { method: 'POST', path: '/orders' },
      websocket: { path: '/live' },
    });
    expect(routes).toEqual([
      { transport: 'http', method: 'POST', path: '/orders' },
      { transport: 'websocket', path: '/live' },
    ]);
  });

  test('optional fields are omitted when absent (no undefined handler/stream leak)', () => {
    const [route] = toExposeRoutes({ http: { method: 'GET', path: '/x' } });
    expect(Object.keys(route!).sort()).toEqual(['method', 'path', 'transport']);
  });

  test('an absent expose yields an empty, frozen route list', () => {
    expect(toExposeRoutes(undefined)).toEqual([]);
    expect(Object.isFrozen(toExposeRoutes(undefined))).toBe(true);
  });

  test('each produced route is frozen', () => {
    const routes = toExposeRoutes({ http: { method: 'GET', path: '/x' } });
    expect(Object.isFrozen(routes)).toBe(true);
    expect(Object.isFrozen(routes[0])).toBe(true);
  });

  test('the route list is JSON-serializable (no zod / live refs)', () => {
    const routes = toExposeRoutes({ http: { method: 'POST', path: '/summary', stream: 'sse' } });
    expect(JSON.parse(JSON.stringify(routes))).toEqual([
      { transport: 'http', method: 'POST', path: '/summary', stream: 'sse' },
    ]);
  });

  test('toExposeRoutes returns readonly ExposeRoute[] (type level)', () => {
    expectTypeOf(toExposeRoutes(undefined)).toEqualTypeOf<readonly ExposeRoute[]>();
  });
});

// --- AC5: path uniqueness within a service and across the fleet ---

describe('validateExpose — single-service well-formedness (AC2/AC5)', () => {
  test('no issues for a valid single route', () => {
    expect(validateExpose({ http: { method: 'POST', path: '/orders' } })).toEqual([]);
  });

  test('no issues for an absent expose', () => {
    expect(validateExpose(undefined)).toEqual([]);
  });

  test('rejects an empty / whitespace path as malformed', () => {
    const issues = validateExpose({ http: { method: 'GET', path: '' } });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('malformed');
  });

  test('the same method+path twice within one service is a duplicate', () => {
    const issues = validateExpose({
      http: [
        { method: 'GET', path: '/orders/:id' },
        { method: 'GET', path: '/orders/:id' },
      ],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('/orders/:id');
    expect(issues[0]).toContain('duplicate');
  });

  test('same path under DIFFERENT http methods is NOT a conflict', () => {
    const issues = validateExpose({
      http: [
        { method: 'GET', path: '/orders' },
        { method: 'POST', path: '/orders' },
      ],
    });
    expect(issues).toEqual([]);
  });

  test('a websocket and an http route on the same path do not collide', () => {
    const issues = validateExpose({
      http: { method: 'GET', path: '/live' },
      websocket: { path: '/live' },
    });
    expect(issues).toEqual([]);
  });
});

describe('validateExposeRoutes — fleet-wide path uniqueness (AC5)', () => {
  test('no issues when every service exposes distinct routes', () => {
    const issues = validateExposeRoutes([
      { service: 'orders', routes: toExposeRoutes({ http: { method: 'POST', path: '/orders' } }) },
      { service: 'billing', routes: toExposeRoutes({ http: { method: 'POST', path: '/charge' } }) },
    ]);
    expect(issues).toEqual([]);
  });

  test('two services claiming the same method+path conflict, naming both (AC5)', () => {
    const issues = validateExposeRoutes([
      { service: 'orders', routes: toExposeRoutes({ http: { method: 'POST', path: '/x' } }) },
      { service: 'legacy', routes: toExposeRoutes({ http: { method: 'POST', path: '/x' } }) },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('/x');
    expect(issues[0]).toContain('orders');
    expect(issues[0]).toContain('legacy');
    expect(issues[0]).toContain('duplicate');
  });

  test('two services claiming the same websocket path conflict', () => {
    const issues = validateExposeRoutes([
      { service: 'a', routes: toExposeRoutes({ websocket: { path: '/live' } }) },
      { service: 'b', routes: toExposeRoutes({ websocket: { path: '/live' } }) },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('/live');
  });

  test('same path under different methods across services is NOT a conflict', () => {
    const issues = validateExposeRoutes([
      { service: 'a', routes: toExposeRoutes({ http: { method: 'GET', path: '/r' } }) },
      { service: 'b', routes: toExposeRoutes({ http: { method: 'POST', path: '/r' } }) },
    ]);
    expect(issues).toEqual([]);
  });

  test('each distinct collision is reported once', () => {
    const issues = validateExposeRoutes([
      { service: 'a', routes: toExposeRoutes({ http: { method: 'GET', path: '/x' } }) },
      { service: 'b', routes: toExposeRoutes({ http: { method: 'GET', path: '/x' } }) },
      { service: 'c', routes: toExposeRoutes({ http: { method: 'GET', path: '/x' } }) },
    ]);
    expect(issues).toHaveLength(1);
  });

  test('validateExposeRoutes returns string[] mirroring validateCalls (type level)', () => {
    expectTypeOf(validateExposeRoutes([])).toEqualTypeOf<string[]>();
  });
});

describe('collectExposeRouteIssues — structured issues for fleet attribution', () => {
  test('a duplicate names both claimant services structurally (no message parsing)', () => {
    const issues = collectExposeRouteIssues([
      { service: 'orders', routes: toExposeRoutes({ http: { method: 'POST', path: '/x' } }) },
      { service: 'legacy', routes: toExposeRoutes({ http: { method: 'POST', path: '/x' } }) },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe('duplicate-route');
    expect([...issues[0]!.services].sort()).toEqual(['legacy', 'orders']);
  });

  test('a malformed route names its declaring service', () => {
    const issues = collectExposeRouteIssues([
      { service: 'orders', routes: [{ transport: 'http', method: 'GET', path: ' ' }] },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe('malformed-route');
    expect(issues[0]!.services).toEqual(['orders']);
  });

  test('the single-service check (empty name) yields no service attribution', () => {
    const issues = collectExposeRouteIssues([
      { service: '', routes: [{ transport: 'http', method: 'GET', path: '' }] },
    ]);
    expect(issues[0]!.services).toEqual([]);
  });

  test('validateExposeRoutes is the message view of the structured issues', () => {
    const input = [
      { service: 'a', routes: toExposeRoutes({ http: { method: 'GET', path: '/x' } }) },
      { service: 'b', routes: toExposeRoutes({ http: { method: 'GET', path: '/x' } }) },
    ];
    expect(validateExposeRoutes(input)).toEqual(
      collectExposeRouteIssues(input).map((issue) => issue.message)
    );
  });
});

describe('ExposeRoute is discriminated on transport', () => {
  test('an http route always carries its method; a websocket route never does (type level)', () => {
    expectTypeOf<HttpExposeRoute['method']>().toEqualTypeOf<HttpMethod>();
    // @ts-expect-error websocket routes carry no HTTP method
    expectTypeOf<WebsocketExposeRoute['method']>();
  });
});

// --- the expose model is re-exported from the package index ---

describe('package index re-exports the expose model', () => {
  test('toExposeRoutes, validateExpose and validateExposeRoutes are exported', () => {
    expect(index.toExposeRoutes).toBe(toExposeRoutes);
    expect(index.validateExpose).toBe(validateExpose);
    expect(index.validateExposeRoutes).toBe(validateExposeRoutes);
  });
});
