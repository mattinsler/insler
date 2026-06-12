import type { FleetManifest, FleetRoute } from '../../fleet/index.js';
import type { GeneratedFile, GeneratorPlugin } from '../types.js';

/**
 * Edge gateway routing derivation (#0014).
 *
 * Collects every `expose` block across the fleet — already flattened onto the
 * {@link FleetManifest}'s `expose.routes` projection by the scanner (#0010) — and
 * synthesizes a single, unified edge gateway routing table. Adding an external
 * route is therefore a one-line change to one service's `expose` block; the
 * shared routing artifact is *derived*, never hand-edited (US-18, AC7).
 *
 * Boundary (ADR-0002): this is a {@link GeneratorPlugin} living inside
 * `@insler/platform/generator`. It consumes only the `FleetManifest` *model* from
 * `@insler/platform/fleet` (the `FleetRoute`s on `expose.routes`), never the filesystem
 * scanner. It produces the *generated artifact* the edge bridge (#0020) loads;
 * it does NOT implement the runtime translation itself.
 */

/** The streaming flavor the edge applies to a route, if any. */
export type EdgeStreamMode = 'sse' | 'ws';

/** The HTTP method an edge route accepts (absent for WebSocket routes). */
export type EdgeHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * One entry in the unified edge routing table. This is the shape the edge
 * bridge (#0020) loads to translate an external request into a NATS RPC call.
 *
 * `path` may carry `:id`-style parameters verbatim (AC4). `method` is present
 * for HTTP routes and absent for WebSocket. `stream` is `'sse'` for an
 * SSE-flavored HTTP route and `'ws'` for a WebSocket route (AC5); plain HTTP
 * routes omit it. `natsSubject` is the internal subject the route maps to,
 * derived as `rpc.{service}.{handler}` (mirroring the NATS transport's
 * `{prefix}.{service}.{method}` layout).
 */
export interface EdgeRoute {
  /** The external transport this route is served over. */
  readonly transport: 'http' | 'websocket';
  /** The HTTP method accepted at the edge (HTTP routes only). */
  readonly method?: EdgeHttpMethod;
  /** The external path mounted, params (`:id`) preserved verbatim. */
  readonly path: string;
  /** The owning service's name. */
  readonly service: string;
  /** The contract method this route maps to (defaults to the service name). */
  readonly handler: string;
  /** The streaming flavor, if any (`'sse'` for HTTP/SSE, `'ws'` for WebSocket). */
  readonly stream?: EdgeStreamMode;
  /** The internal NATS subject this route translates to. */
  readonly natsSubject: string;
}

/**
 * The complete, fleet-wide edge routing table — the generated artifact the edge
 * bridge consumes. `routes` is deterministically ordered (by path, then method)
 * so the file-level diff is meaningful (Notes, AC7).
 */
export interface EdgeRoutingTable {
  /** Every exposed route across the fleet, in stable order. */
  readonly routes: readonly EdgeRoute[];
}

/** The NATS subject prefix the host transport uses by default (`rpc`). */
const SUBJECT_PREFIX = 'rpc';

/**
 * Derive one {@link EdgeRoute} from a flattened {@link FleetRoute}. The handler
 * defaults to the owning service's name when the `expose` declaration named
 * none (a single-method service the edge can infer) — matching the issue
 * example where `summarize` maps to `rpc.summarize.summarize`. A WebSocket
 * route carries no method and is tagged `stream: 'ws'`.
 */
function toEdgeRoute(route: FleetRoute): EdgeRoute {
  const handler = route.handler ?? route.service;
  const stream: EdgeStreamMode | undefined = route.transport === 'websocket' ? 'ws' : route.stream;
  return {
    transport: route.transport,
    path: route.path,
    service: route.service,
    handler,
    natsSubject: `${SUBJECT_PREFIX}.${route.service}.${handler}`,
    ...(route.method !== undefined ? { method: route.method } : {}),
    ...(stream !== undefined ? { stream } : {}),
  };
}

/**
 * The transport-qualified key two routes collide on: `(method, path)` for HTTP,
 * `path` alone for WebSocket. Mirrors the per-service rule in `@insler/service`
 * so a WebSocket endpoint and an HTTP route may share a path (AC3).
 */
function conflictKey(route: EdgeRoute): string {
  return route.transport === 'http'
    ? `http ${route.method ?? 'GET'} ${route.path}`
    : `ws ${route.path}`;
}

/**
 * Fleet-wide conflict check (AC3): no two services may claim the same external
 * route. The fleet scanner (#0010) already rejects duplicates while building the
 * manifest, but the plugin re-asserts the invariant locally so it can never
 * emit a self-conflicting table — and fails loudly, naming the path and both
 * services (matching the engine's path-collision philosophy).
 */
function assertNoConflicts(routes: readonly EdgeRoute[]): void {
  const owner = new Map<string, string>();
  for (const route of routes) {
    const key = conflictKey(route);
    const existing = owner.get(key);
    if (existing !== undefined && existing !== route.service) {
      throw new Error(
        `edge-routing: route conflict on '${route.path}' (${route.method ?? route.transport}) ` +
          `claimed by both '${existing}' and '${route.service}'`
      );
    }
    owner.set(key, route.service);
  }
}

/** Stable ordering for a meaningful diff: by path, then method (WebSocket last). */
function byPathThenMethod(a: EdgeRoute, b: EdgeRoute): number {
  if (a.path !== b.path) {
    return a.path < b.path ? -1 : 1;
  }
  const am = a.method ?? '~';
  const bm = b.method ?? '~';
  return am < bm ? -1 : am > bm ? 1 : 0;
}

/**
 * The edge gateway routing plugin (#0014). Flattens the manifest's `expose`
 * projection into a unified, deterministically-ordered routing table, validates
 * there are no cross-service path+method conflicts, and emits it as a single
 * JSON artifact the edge bridge (#0020) loads.
 */
export const edgeRoutingPlugin: GeneratorPlugin = {
  name: 'edge-routing',
  generate(manifest: FleetManifest): readonly GeneratedFile[] {
    const routes = manifest.expose.routes.map(toEdgeRoute).sort(byPathThenMethod);
    assertNoConflicts(routes);

    const table: EdgeRoutingTable = { routes };
    return [
      {
        path: 'edge/routing-table.json',
        content: `${JSON.stringify(table, null, 2)}\n`,
        format: 'json',
      },
    ];
  },
};
