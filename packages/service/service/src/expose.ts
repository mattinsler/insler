/**
 * External transport annotations (`expose`) — the typed contract.
 *
 * A service author optionally declares that the service should be reachable
 * over an external transport (HTTP, WebSocket, SSE). `expose` is **orthogonal
 * to `kind`**: any kind can be exposed, and declaring exposure does NOT change
 * the service's lifecycle kind or its internal protocol. The service still
 * speaks NATS internally; the edge bridge translates the external transport to
 * NATS (US-17, US-19). Internal services never terminate TLS, parse raw
 * untrusted input, or implement transport concerns — those are concentrated in
 * the edge bridge (US-20, `#0020`).
 *
 * This module owns only the logical model downstream consumers build on: the
 * typed transport options, their flattening into a transport-agnostic
 * {@link ExposeRoute} list, and the well-formedness / path-uniqueness rules.
 * The synthesis of a single edge gateway routing table from the routes across
 * ALL services (US-18) is owned by the edge-gateway routing generator
 * (`#0014`); the edge bridge that performs the runtime translation is `#0020`.
 */

/** The HTTP methods an exposed route may use. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** The streaming flavor the edge applies when translating a route. */
export type StreamMode = 'sse' | 'ws';

/**
 * A single HTTP route the edge bridge should expose for this service. It
 * carries only transport-shape intent — method, path, the optional contract
 * method it maps to (`handler`), and an optional streaming flavor — never any
 * deployment or transport-termination concern.
 */
export interface HttpExpose {
  /** The HTTP method to accept at the edge. */
  readonly method: HttpMethod;
  /** The external path to mount (e.g. `'/orders'`, `'/orders/:id'`). */
  readonly path: string;
  /**
   * The contract method this route maps to. Optional: when a service exposes a
   * single method the edge can infer it; with multiple routes each names its
   * target method explicitly.
   */
  readonly handler?: string;
  /** Optional streaming flavor for the edge translation (`'sse'` or `'ws'`). */
  readonly stream?: StreamMode;
}

/**
 * A single WebSocket route the edge bridge should expose. WebSocket is a
 * first-class transport option alongside HTTP (AC3): unlike an SSE-flavored
 * HTTP route it has no method, only a path and an optional target method.
 */
export interface WebsocketExpose {
  /** The external path to mount the WebSocket endpoint at. */
  readonly path: string;
  /** The contract method this socket maps to (optional, as with HTTP). */
  readonly handler?: string;
}

/**
 * Optional external exposure for a service. Orthogonal to its kind. `http` may
 * be a single route or a list of routes (a service can expose several methods);
 * `websocket` adds a WebSocket endpoint. All fields are optional — an empty or
 * absent `expose` means the service is internal-only (NATS only).
 */
export interface ExposeConfig {
  /** One HTTP route, or a list of HTTP routes, to expose. */
  readonly http?: HttpExpose | readonly HttpExpose[];
  /** A WebSocket endpoint to expose. */
  readonly websocket?: WebsocketExpose;
}

/** The flattened projection of one HTTP route. `method` is always present —
 * {@link HttpExpose} requires it, so the projection never invents a default. */
export interface HttpExposeRoute {
  /** Discriminant: served over HTTP. */
  readonly transport: 'http';
  /** The HTTP method. */
  readonly method: HttpMethod;
  /** The external path mounted. */
  readonly path: string;
  /** The contract method this route maps to, if declared. */
  readonly handler?: string;
  /** The streaming flavor, if declared. */
  readonly stream?: StreamMode;
}

/** The flattened projection of the WebSocket endpoint — no HTTP method. */
export interface WebsocketExposeRoute {
  /** Discriminant: served over WebSocket. */
  readonly transport: 'websocket';
  /** The external path mounted. */
  readonly path: string;
  /** The contract method this socket maps to, if declared. */
  readonly handler?: string;
}

/**
 * A flattened, transport-agnostic view of one exposed route — the unit the edge
 * gateway routing table (`#0014`) is built from. Every entry in a service's
 * {@link ExposeConfig} (each HTTP route, the WebSocket endpoint) projects to one
 * of these. Discriminated on `transport`, so an HTTP route *always* carries its
 * `method` (no dead `?? 'GET'` defaults downstream) and a WebSocket route never
 * does.
 */
export type ExposeRoute = HttpExposeRoute | WebsocketExposeRoute;

/** Normalize the `http` field to a list (single route → one-element list). */
function httpRoutes(http: ExposeConfig['http']): readonly HttpExpose[] {
  if (http === undefined) {
    return [];
  }
  return Array.isArray(http) ? http : [http as HttpExpose];
}

/**
 * Flatten an `expose` declaration into the list of transport-agnostic
 * {@link ExposeRoute}s the edge gateway routing generator (`#0014`) consumes.
 * Returns a deeply-frozen, empty-when-absent list. Each HTTP route and the
 * optional WebSocket endpoint becomes one entry; optional fields (`handler`,
 * `stream`) are carried through only when present.
 */
export function toExposeRoutes(expose: ExposeConfig | undefined): readonly ExposeRoute[] {
  if (expose === undefined) {
    return Object.freeze([]);
  }

  const routes: ExposeRoute[] = [];

  for (const route of httpRoutes(expose.http)) {
    routes.push(
      Object.freeze({
        transport: 'http' as const,
        method: route.method,
        path: route.path,
        ...(route.handler !== undefined ? { handler: route.handler } : {}),
        ...(route.stream !== undefined ? { stream: route.stream } : {}),
      })
    );
  }

  if (expose.websocket !== undefined) {
    routes.push(
      Object.freeze({
        transport: 'websocket' as const,
        path: expose.websocket.path,
        ...(expose.websocket.handler !== undefined ? { handler: expose.websocket.handler } : {}),
      })
    );
  }

  return Object.freeze(routes);
}

/**
 * Validate a single service's `expose` declaration. Returns an array of
 * human-readable issues, or an empty array if valid (mirroring `validateNeeds`
 * / `validateCalls`).
 *
 * Rules enforced:
 * - every route must declare a non-empty `path`;
 * - within one service, no two routes may collide on the same
 *   `(method, path)` for HTTP or `path` for WebSocket (the per-service half of
 *   the fleet-wide uniqueness rule — see {@link validateExposeRoutes}).
 */
export function validateExpose(expose: ExposeConfig | undefined): string[] {
  if (expose === undefined) {
    return [];
  }
  return validateExposeRoutes([{ service: '', routes: toExposeRoutes(expose) }]);
}

/** One service's contribution to the fleet-wide route set. */
export interface ServiceExposeRoutes {
  /** The declaring service's name (used in conflict messages). Empty for a single-service check. */
  readonly service: string;
  /** The flattened routes that service exposes (from {@link toExposeRoutes}). */
  readonly routes: readonly ExposeRoute[];
}

/** The transport-qualified key two routes collide on. HTTP collides on
 * `(method, path)`; WebSocket collides on `path` alone. */
function routeKey(route: ExposeRoute): string {
  return route.transport === 'http' ? `http ${route.method} ${route.path}` : `ws ${route.path}`;
}

/** The rule a route violated. */
export type ExposeRouteIssueKind = 'malformed-route' | 'duplicate-route';

/**
 * One structured route-validation problem. `services` names the declaring
 * service(s) — the duplicate's two claimants, or the malformed route's single
 * owner — so a consumer (the fleet scanner) can map an issue back to source
 * files without parsing the human-readable `message`.
 */
export interface ExposeRouteIssue {
  /** The rule that failed. */
  readonly kind: ExposeRouteIssueKind;
  /** A human-readable description of the problem. */
  readonly message: string;
  /** The implicated service name(s), in discovery order (empty names omitted). */
  readonly services: readonly string[];
}

/**
 * Validate exposed routes across one or more services for the fleet-wide
 * uniqueness rule (AC5): two services may not claim the same external route.
 * Returns structured issues, or an empty array if valid.
 *
 * This is the validation primitive the edge-gateway routing generator (`#0014`)
 * and the fleet scanner (`#0010`) run; the generator wiring (collecting every
 * service's `expose` block from the static analysis pass) is owned by `#0014`.
 * Here we own only the rule itself.
 *
 * Rules enforced:
 * - every route must declare a non-empty `path`;
 * - no two routes (across all supplied services) may share the same transport
 *   route key — `(method, path)` for HTTP, `path` for WebSocket. Each distinct
 *   collision is reported once, naming the conflicting services when known.
 */
export function collectExposeRouteIssues(
  services: readonly ServiceExposeRoutes[]
): ExposeRouteIssue[] {
  const issues: ExposeRouteIssue[] = [];
  const owner = new Map<string, string>();
  const reported = new Set<string>();

  for (const { service, routes } of services) {
    for (const route of routes) {
      if (route.path.trim() === '') {
        issues.push({
          kind: 'malformed-route',
          message: `malformed expose route: a route path must be a non-empty string`,
          services: service === '' ? [] : [service],
        });
        continue;
      }
      const key = routeKey(route);
      const existing = owner.get(key);
      if (existing !== undefined && !reported.has(key)) {
        const where =
          service === '' && existing === ''
            ? `'${route.path}' is exposed more than once`
            : `'${route.path}' is exposed by both '${existing}' and '${service}'`;
        issues.push({
          kind: 'duplicate-route',
          message: `duplicate expose route: ${where}`,
          services: [...new Set([existing, service])].filter((name) => name !== ''),
        });
        reported.add(key);
      } else if (existing === undefined) {
        owner.set(key, service);
      }
    }
  }

  return issues;
}

/**
 * The string view of {@link collectExposeRouteIssues} — each issue reduced to
 * its human-readable message (mirroring `validateNeeds` / `validateCalls`).
 */
export function validateExposeRoutes(services: readonly ServiceExposeRoutes[]): string[] {
  return collectExposeRouteIssues(services).map((issue) => issue.message);
}
