import { type Msg, type NatsConnection, nuid, type Subscription } from '@nats-io/transport-node';

import type { EndpointStats, StatsStore } from './stats.js';

/**
 * ADR-32 discovery control plane for `@insler/rpc-transport-nats`.
 *
 * A hosted `@insler` service is presented to the NATS ecosystem as a standard
 * NATS micro service (NATS ADR-32), so the off-the-shelf `nats micro` CLI and any
 * ADR-32 client can discover, ping, and (later) introspect/observe it with zero
 * bespoke tooling. See `docs/adr/0001-nats-service-protocol.md` §1.
 *
 * This module owns the *control plane only* — the `$SRV.*` subject hierarchy, the
 * per-`register()` instance identity, the service-name charset validation, and the
 * verbatim `io.nats.micro.v1.*` response schemas. The application/RPC subjects
 * (`{subjectPrefix}.{service}.{method}`) carry no `$SRV` prefix and are handled by
 * the host transport's data plane.
 *
 * Wire format: control-plane responses are encoded as **plain JSON** (UTF-8),
 * independent of the injected application serde. ADR-32 mandates the verbatim
 * `io.nats.micro.v1.*` JSON schema so off-the-shelf tooling (the `nats micro` CLI,
 * any ADR-32 client) can parse it; routing it through a pluggable serde (which may
 * be CBOR/msgpack, or — like `jsonBytesSerde` — wrap values in its own envelope)
 * would make the service undiscoverable by standard tooling. The serde governs the
 * application/RPC payloads, never the discovery control plane.
 *
 * Scope note: this module answers all three control verbs — `$SRV.PING`,
 * `$SRV.INFO`, and `$SRV.STATS` — over the same subscription/teardown machinery
 * ({@link DiscoveryService.subscribeVerb}); the control-subject wiring, id, and name
 * validation are shared by all three. STATS reads its per-endpoint counters and the
 * `started` instant from the host transport's {@link StatsStore} (unary accounting in
 * issue 0011; streaming call-level accounting in 0012 plugs into the same store).
 */

/** The three ADR-32 control verbs, all implemented. */
export type DiscoveryVerb = 'PING' | 'INFO' | 'STATS';

/**
 * ADR-32 service-name charset: `A–Z a–z 0–9 - _`. The service `name` advertised on
 * the control plane must match this; a name that cannot be advertised must fail
 * loudly on `register()` rather than silently skip discovery.
 */
const SERVICE_NAME_CHARSET = /^[A-Za-z0-9_-]+$/;

/**
 * Validate a contract service name against the ADR-32 charset. Throws a clear error
 * if the name is empty or contains characters outside `A–Z a–z 0–9 - _`.
 */
export function assertValidServiceName(name: string): void {
  if (!SERVICE_NAME_CHARSET.test(name)) {
    throw new Error(
      `Invalid NATS service name '${name}': ADR-32 restricts the service name to the ` +
        `charset A-Z a-z 0-9 - _ (a contract whose service name cannot be advertised on ` +
        `the discovery plane must fail loudly, not silently skip discovery).`
    );
  }
}

/** Mint a unique service `id` for a single `register()` (ADR-32 instance identity). */
function mintServiceId(): string {
  return nuid.next();
}

/**
 * The verbatim ADR-32 `io.nats.micro.v1.ping_response`. Standard fields only:
 * `type`, `name`, `id`, `version`, `metadata`. Field names are verbatim so
 * off-the-shelf ADR-32 clients (and the `nats micro` CLI) parse it without
 * adaptation.
 */
export interface PingResponse {
  type: 'io.nats.micro.v1.ping_response';
  name: string;
  id: string;
  version: string;
  metadata: Record<string, string>;
}

/**
 * The verbatim ADR-32 `io.nats.micro.v1.info_response`. Carries the standard
 * fields (`type`, `name`, `id`, `version`, `metadata`) plus `description` and one
 * {@link EndpointInfo} per contract method. Field names are verbatim so the
 * `nats micro` CLI and any ADR-32 client introspect the service without adaptation.
 */
export interface InfoResponse {
  type: 'io.nats.micro.v1.info_response';
  name: string;
  id: string;
  version: string;
  metadata: Record<string, string>;
  description: string;
  endpoints: EndpointInfo[];
}

/**
 * One ADR-32 endpoint, mapped from a single contract method (ADR-0001 §1.1/§1.3).
 *
 * - `subject` is the method's RPC subject `{subjectPrefix}.{service}.{method}`.
 * - `queue_group` is the host's configured queue (default `q`).
 * - `metadata` advertises the framework descriptors (`dev.insler.rpc.kind`,
 *   `dev.insler.rpc.contract_version`, and the optional pass-through fingerprints
 *   `dev.insler.rpc.input` / `dev.insler.rpc.output`).
 */
export interface EndpointInfo {
  name: string;
  subject: string;
  queue_group: string;
  metadata: Record<string, string>;
}

/**
 * The verbatim ADR-32 `io.nats.micro.v1.stats_response` (ADR-0001 §1.3). Carries the
 * standard fields (`type`, `name`, `id`, `version`, `metadata`) plus `started` (the
 * registration instant, ISO-8601 UTC) and one {@link EndpointStats} per contract
 * method. Field names are verbatim so the `nats micro stats` CLI and any ADR-32
 * client parse it without adaptation; `processing_time` / `average_processing_time`
 * on each endpoint are in nanoseconds.
 */
export interface StatsResponse {
  type: 'io.nats.micro.v1.stats_response';
  name: string;
  id: string;
  version: string;
  metadata: Record<string, string>;
  started: string;
  endpoints: EndpointStats[];
}

export interface DiscoveryServiceOptions {
  connection: NatsConnection;
  /** The contract service name (ADR-32 `name`); validated by the caller. */
  name: string;
  /** The service version (ADR-32 `version`). */
  version: string;
  /** Service-level metadata advertised on responses. */
  metadata: Record<string, string>;
  /**
   * The contract description (ADR-32 `description`). Defaults to `''` (the empty
   * string) when the contract has no description — the field is always present on
   * the verbatim `info_response`.
   */
  description: string;
  /**
   * One ADR-32 endpoint per contract method, fully assembled by the host transport
   * (it owns the subject layout, queue, kind, and any supplied fingerprints).
   */
  endpoints: EndpointInfo[];
  /**
   * The per-endpoint stats counters and `started` instant, owned by the host
   * transport and read back verbatim on `$SRV.STATS` (ADR-0001 §1.3-1.4). The host
   * mutates the recorders as it serves calls; this is a live read-through.
   */
  stats: StatsStore;
}

/**
 * Owns one hosted service's ADR-32 control plane for a single `register()`.
 *
 * Lifecycle: construct → {@link start} (subscribes the control subjects) →
 * {@link stop} (unsubscribes). The minted {@link id} is stable for the lifetime of
 * the instance, i.e. for that registration.
 *
 * Each verb (PING now; INFO/STATS later) is subscribed at all three ADR-32 scopes
 * without a queue group, so every host instance answers and discovery enumerates
 * the whole fleet:
 *
 *   $SRV.<VERB>            $SRV.<VERB>.<name>            $SRV.<VERB>.<name>.<id>
 */
export class DiscoveryService {
  private static readonly encoder = new TextEncoder();

  private readonly connection: NatsConnection;
  private readonly name: string;
  private readonly version: string;
  private readonly metadata: Record<string, string>;
  private readonly description: string;
  private readonly endpoints: EndpointInfo[];
  private readonly stats: StatsStore;
  private readonly serviceId: string;
  private readonly subscriptions: Subscription[] = [];

  constructor(options: DiscoveryServiceOptions) {
    this.connection = options.connection;
    this.name = options.name;
    this.version = options.version;
    this.metadata = options.metadata;
    this.description = options.description;
    this.endpoints = options.endpoints;
    this.stats = options.stats;
    this.serviceId = mintServiceId();
  }

  /** The unique service `id` minted for this registration (stable for its lifetime). */
  get id(): string {
    return this.serviceId;
  }

  /** Subscribe every control verb at all three ADR-32 scopes (no queue group). */
  start(): void {
    this.subscribeVerb('PING', (msg) => this.respondPing(msg));
    this.subscribeVerb('INFO', (msg) => this.respondInfo(msg));
    this.subscribeVerb('STATS', (msg) => this.respondStats(msg));
  }

  /** Unsubscribe every control subject for this registration. */
  stop(): void {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions.length = 0;
  }

  /**
   * Subscribe a single ADR-32 verb at all three scopes WITHOUT a queue group, so
   * every host instance answers (this is how discovery enumerates the fleet rather
   * than load-balancing to one instance). INFO/STATS reuse this exact wiring.
   */
  private subscribeVerb(verb: DiscoveryVerb, respond: (msg: Msg) => void): void {
    const subjects = [
      `$SRV.${verb}`,
      `$SRV.${verb}.${this.name}`,
      `$SRV.${verb}.${this.name}.${this.serviceId}`,
    ];

    for (const subject of subjects) {
      // No `queue` option: control subjects are intentionally un-grouped.
      const subscription = this.connection.subscribe(subject, {
        callback: (err, msg) => {
          if (err) {
            return;
          }
          respond(msg);
        },
      });
      this.subscriptions.push(subscription);
    }
  }

  private respondPing(msg: Msg): void {
    const response: PingResponse = {
      type: 'io.nats.micro.v1.ping_response',
      name: this.name,
      id: this.serviceId,
      version: this.version,
      metadata: this.metadata,
    };
    // Plain JSON, not the injected serde — see the module note on wire format.
    msg.respond(DiscoveryService.encoder.encode(JSON.stringify(response)));
  }

  private respondInfo(msg: Msg): void {
    const response: InfoResponse = {
      type: 'io.nats.micro.v1.info_response',
      name: this.name,
      id: this.serviceId,
      version: this.version,
      metadata: this.metadata,
      description: this.description,
      endpoints: this.endpoints,
    };
    // Plain JSON, not the injected serde — see the module note on wire format.
    msg.respond(DiscoveryService.encoder.encode(JSON.stringify(response)));
  }

  private respondStats(msg: Msg): void {
    // Snapshot the live per-endpoint counters at response time (ADR-0001 §1.3-1.4).
    // `started` is the registration instant; `endpoints` carry the verbatim ADR-32
    // `EndpointStats` with `processing_time`/`average_processing_time` in nanoseconds.
    const endpoints: EndpointStats[] = this.stats.snapshot();
    const response: StatsResponse = {
      type: 'io.nats.micro.v1.stats_response',
      name: this.name,
      id: this.serviceId,
      version: this.version,
      metadata: this.metadata,
      started: this.stats.started,
      endpoints,
    };
    // Plain JSON, not the injected serde — see the module note on wire format.
    msg.respond(DiscoveryService.encoder.encode(JSON.stringify(response)));
  }
}
