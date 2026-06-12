import type { ServiceDef, ServiceEnv } from '@insler/service';
import { collectExposeRouteIssues, deriveIdentity } from '@insler/service';
import type { HttpMethod, ServiceExposeRoutes, StreamMode } from '@insler/service';

/**
 * The desired-state model of an entire fleet — the unified collection of every
 * service's declared intent. It is the output of the scanner (`scanFleet`) and
 * the input to the generator (#0011+): every physical artifact is derived from
 * this single model, never from a hand-authored values file.
 *
 * A `FleetManifest` carries three orthogonal projections of the scanned
 * {@link ServiceDef}s:
 *
 * - `services` — the raw declarations (live contracts intact), in discovery
 *   order. The source of truth the other two projections are derived from.
 * - `graph` — the dependency graph: one edge per `calls` and per `needs`
 *   relationship a service declares. `calls` edges point at the producing
 *   service (resolved by subject); `needs` edges point at the logical resource
 *   name (the platform resolves it to a physical resource downstream).
 * - `expose` — the flattened, fleet-wide external routing table: every exposed
 *   route across all services, tagged with its owning service.
 */
export interface FleetManifest {
  /** Every scanned service declaration, in discovery order. */
  readonly services: readonly ServiceDef[];
  /** The fleet dependency graph derived from `calls` and `needs`. */
  readonly graph: FleetGraph;
  /** The flattened external routing table derived from every `expose` block. */
  readonly expose: FleetExpose;
}

/** The dependency graph projection of a {@link FleetManifest}. */
export interface FleetGraph {
  /** One edge per declared `calls` / `needs` relationship. */
  readonly edges: readonly FleetEdge[];
}

/**
 * A single dependency edge. `from` is always a service name. For a `calls` edge
 * `to` is the producing service's name (resolved from the called subject); for
 * a `needs` edge `to` is the logical resource name the consumer declared.
 */
export interface FleetEdge {
  /** The declaring (consuming) service's name. */
  readonly from: string;
  /** The target: a producing service name (`calls`) or a logical need (`needs`). */
  readonly to: string;
  /** Which relationship produced this edge. */
  readonly type: 'calls' | 'needs';
}

/** The external routing table projection of a {@link FleetManifest}. */
export interface FleetExpose {
  /** Every exposed route across the fleet, tagged with its owning service. */
  readonly routes: readonly FleetRoute[];
}

/**
 * One exposed route in the fleet-wide routing table. Mirrors the issue's
 * `{ path, method, service, handler }` shape, with `transport`/`stream` carried
 * through from the underlying {@link ExposeRoute} so the edge-gateway routing
 * generator (#0014) does not have to re-derive them.
 */
export interface FleetRoute {
  /** The external path mounted. */
  readonly path: string;
  /** The HTTP method (HTTP routes only; absent for WebSocket). */
  readonly method?: HttpMethod;
  /** The owning service's name. */
  readonly service: string;
  /** The contract method this route maps to, if the declaration named one. */
  readonly handler?: string;
  /** Which external transport this route is served over. */
  readonly transport: 'http' | 'websocket';
  /** The streaming flavor, if declared (HTTP routes only). */
  readonly stream?: StreamMode;
}

/**
 * A scanned service paired with the source file it was discovered in. The
 * location travels with the declaration so every validation error can point at
 * the exact file the author must edit (AC6).
 */
export interface ScannedService {
  /** The service declaration extracted from the source file. */
  readonly service: ServiceDef;
  /** The file the declaration was exported from (absolute path). */
  readonly file: string;
}

/**
 * A single fleet-validation problem, always carrying the source file(s) it
 * concerns so the CLI can report errors with locations (AC6).
 */
export interface FleetError {
  /** The validation rule that failed. */
  readonly kind:
    | 'duplicate-service-name'
    | 'duplicate-service-identity'
    | 'duplicate-expose-route'
    | 'malformed-expose-route'
    | 'unknown-call-subject';
  /** A human-readable description of the problem. */
  readonly message: string;
  /** The source file(s) implicated, in discovery order. */
  readonly files: readonly string[];
}

/**
 * The outcome of building a {@link FleetManifest}. On success `errors` is empty
 * and `manifest` is the complete desired state. When cross-service constraints
 * fail, `errors` is non-empty (each with file locations) and `manifest` is
 * `undefined` — the manifest is only trustworthy when the fleet is valid.
 */
export interface FleetResult {
  /** The complete manifest, present only when `errors` is empty. */
  readonly manifest: FleetManifest | undefined;
  /** Every cross-service validation problem found, with locations. */
  readonly errors: readonly FleetError[];
}

/** The set of RPC subjects a service serves: `{contract.kind}.{method}` per method. */
function ownSubjects(service: ServiceDef): readonly string[] {
  return service.contract.methodList.map((method) => `${service.contract.kind}.${method.name}`);
}

/**
 * Build the fleet dependency graph: one edge per `calls` and per `needs`
 * relationship. `calls` edges are resolved to the producing service by matching
 * the called subject against each service's own subjects; an unresolved subject
 * is reported separately as an `unknown-call-subject` error, so the graph only
 * carries edges whose target is known.
 */
function buildEdges(
  scanned: readonly ScannedService[],
  subjectOwner: ReadonlyMap<string, string>
): readonly FleetEdge[] {
  const edges: FleetEdge[] = [];

  for (const { service } of scanned) {
    for (const need of service.needRefs) {
      edges.push({ from: service.name, to: need.name, type: 'needs' });
    }
    for (const call of service.callRefs) {
      const target = subjectOwner.get(call.subject);
      if (target !== undefined) {
        edges.push({ from: service.name, to: target, type: 'calls' });
      }
    }
  }

  return edges;
}

/** Flatten every service's exposed routes into the fleet-wide routing table. */
function buildRoutes(scanned: readonly ScannedService[]): readonly FleetRoute[] {
  const routes: FleetRoute[] = [];

  for (const { service } of scanned) {
    for (const route of service.exposeRoutes) {
      routes.push({
        path: route.path,
        service: service.name,
        transport: route.transport,
        ...(route.handler !== undefined ? { handler: route.handler } : {}),
        ...(route.transport === 'http'
          ? {
              method: route.method,
              ...(route.stream !== undefined ? { stream: route.stream } : {}),
            }
          : {}),
      });
    }
  }

  return routes;
}

/**
 * Validate cross-service constraints and assemble the {@link FleetManifest} from
 * already-loaded, located declarations. This is the pure core the filesystem
 * scanner (`scanFleet`) delegates to: it performs no I/O, so the generator and
 * tests can drive it directly with fixture declarations.
 *
 * Enforced (each failure carries the implicated file location(s) — AC6):
 * - **unique service names** (AC3): two declarations may not share a `name`.
 * - **unique service identity** (#0004 AC3): no two declarations may derive the
 *   same {@link ServiceIdentity} (`environment.namespace.name`) — delegated to
 *   `@insler/service`'s {@link deriveIdentity}. The type and derivation live in
 *   `@insler/service`; this is the cross-fleet uniqueness half of the model.
 * - **unique exposed routes** (AC4): two services may not claim the same
 *   external route — delegated to `@insler/service`'s {@link validateExposeRoutes}.
 * - **calls reference valid subjects**: every `calls` subject must resolve to a
 *   method served by some scanned service.
 *
 * `environment` qualifies the derived identities (a fleet is built for one
 * deployment environment at a time); it defaults to `production`.
 *
 * Returns a {@link FleetResult}; `manifest` is populated only when `errors` is
 * empty, so a caller never builds artifacts from an invalid fleet.
 */
export function buildFleetManifest(
  scanned: readonly ScannedService[],
  environment: ServiceEnv = 'production'
): FleetResult {
  const errors: FleetError[] = [];

  // AC3 — unique service names. Group files by name so a collision reports
  // every file that declared the duplicated name.
  const filesByName = new Map<string, string[]>();
  for (const { service, file } of scanned) {
    const files = filesByName.get(service.name);
    if (files === undefined) {
      filesByName.set(service.name, [file]);
    } else {
      files.push(file);
    }
  }
  for (const [name, files] of filesByName) {
    if (files.length > 1) {
      errors.push({
        kind: 'duplicate-service-name',
        message: `service name '${name}' is declared by ${files.length} services`,
        files,
      });
    }
  }

  // #0004 AC3 — unique service identity. Two declarations may not derive the
  // same identity (`environment.namespace.name`). Distinct names can collide on
  // identity (e.g. two `orders.summarize`), so this is checked independently of
  // the raw-name rule. Group files by qualified identity and report each
  // colliding identity once, naming every file that derived it.
  const filesByIdentity = new Map<string, string[]>();
  for (const { service, file } of scanned) {
    const { qualifiedName } = deriveIdentity(service, environment);
    const files = filesByIdentity.get(qualifiedName);
    if (files === undefined) {
      filesByIdentity.set(qualifiedName, [file]);
    } else {
      files.push(file);
    }
  }
  for (const [qualifiedName, files] of filesByIdentity) {
    if (files.length > 1) {
      errors.push({
        kind: 'duplicate-service-identity',
        message: `service identity '${qualifiedName}' is derived by ${files.length} services`,
        files,
      });
    }
  }

  // Map every served subject to its owning service name (used for both the
  // calls-graph resolution and the unknown-subject check).
  const subjectOwner = new Map<string, string>();
  for (const { service } of scanned) {
    for (const subject of ownSubjects(service)) {
      subjectOwner.set(subject, service.name);
    }
  }

  // calls reference valid subjects — every called subject must be served by
  // some scanned service.
  for (const { service, file } of scanned) {
    for (const call of service.callRefs) {
      if (!subjectOwner.has(call.subject)) {
        errors.push({
          kind: 'unknown-call-subject',
          message: `service '${service.name}' calls '${call.subject}', which no scanned service serves`,
          files: [file],
        });
      }
    }
  }

  // AC4 — unique exposed routes across the fleet. Reuse the service-layer rule;
  // its structured issues name the implicated services directly, so files are
  // resolved by name lookup — never by parsing the human-readable message.
  const fileByService = new Map<string, string>();
  for (const { service, file } of scanned) {
    if (!fileByService.has(service.name)) {
      fileByService.set(service.name, file);
    }
  }
  const exposeInput: ServiceExposeRoutes[] = scanned.map(({ service }) => ({
    service: service.name,
    routes: service.exposeRoutes,
  }));
  for (const issue of collectExposeRouteIssues(exposeInput)) {
    const files = issue.services
      .map((name) => fileByService.get(name))
      .filter((file): file is string => file !== undefined);
    errors.push({
      kind: issue.kind === 'malformed-route' ? 'malformed-expose-route' : 'duplicate-expose-route',
      message: issue.message,
      files,
    });
  }

  if (errors.length > 0) {
    return { manifest: undefined, errors };
  }

  const manifest: FleetManifest = {
    services: scanned.map(({ service }) => service),
    graph: { edges: buildEdges(scanned, subjectOwner) },
    expose: { routes: buildRoutes(scanned) },
  };

  return { manifest, errors: [] };
}
