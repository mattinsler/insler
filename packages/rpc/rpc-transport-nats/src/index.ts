export { NatsClientTransport } from './client-transport.js';
export type { NatsClientTransportOptions } from './client-transport.js';
export type { EndpointInfo, InfoResponse, PingResponse, StatsResponse } from './discovery.js';
export type { CallOutcome, EndpointIdentity, EndpointStats, RecordedError } from './stats.js';
export { EndpointStatsRecorder, StatsStore } from './stats.js';
export {
  type CancelFrame,
  type CreditFrame,
  type DataFrame,
  decodeFrame,
  encodeFrame,
  type EndFrame,
  type ErrorFrame,
  type Frame,
  FrameDecodeError,
  type FrameError,
  type FrameTag,
  SeqCounter,
} from './frames.js';
export { NatsHostTransport } from './host-transport.js';
export type { NatsHostTransportOptions } from './host-transport.js';
export {
  buildLeafNodeServerConfig,
  type LeafNode,
  type LeafNodeConfig,
  type LeafNodeRemote,
  type LeafNodeServerConfig,
  renderLeafNodeServerConfig,
  startLeafNode,
} from './leaf-node.js';
export {
  DEFAULT_IDLE_TIMEOUT_MS,
  type LivenessExpiry,
  type LivenessMonitor,
  type LivenessOptions,
  startLivenessMonitor,
  TIMEOUT_TAG,
} from './liveness.js';
export { allocateCallInboxes, type CallSubscription, subscribeFrames } from './streaming.js';

import type { Serde } from '@insler/serde';
import type { NatsConnection } from '@nats-io/transport-node';

import { NatsClientTransport } from './client-transport.js';
import { NatsHostTransport } from './host-transport.js';

/**
 * Create a connected NATS transport pair (client + host) backed by a shared NATS connection.
 *
 * This is the primary convenience function for setting up NATS-based RPC:
 * - Both transports share the same connection and serde
 * - Client sends requests via NATS request/reply
 * - Host subscribes to service method subjects and responds
 */
export function createNatsTransport(options: {
  connection: NatsConnection;
  serde?: Serde<Uint8Array>;
  timeout?: number;
  subjectPrefix?: string;
  queue?: string;
  /**
   * Initial credit the client grants the host on a streaming call's `down`
   * window (ADR-0001 §2.5). Defaults to the client transport's large default;
   * set a small value to bound in-flight buffering tightly.
   */
  credit?: number;
  /**
   * Per-call idle (stall) window in ms for streaming calls (ADR-0001 §2.7). A call
   * whose peer goes silent past this window fails with `__timeout__` and tears down
   * both inboxes. Applied to BOTH the client (`down`) and host (`up`) sides.
   * Defaults to {@link DEFAULT_IDLE_TIMEOUT_MS}; `0`/negative disables it.
   */
  idleTimeout?: number;
  /**
   * Optional overall deadline in ms for a streaming call (ADR-0001 §2.7): a hard
   * ceiling after which the call is cancelled with `__timeout__`. **Default off** —
   * streams may be long-lived. Applied to both client and host sides.
   */
  deadline?: number;
  /** Service version advertised on the ADR-32 discovery plane. Defaults to `'0.0.0'`. */
  version?: string;
  /** Service-level metadata advertised on discovery responses. Defaults to `{}`. */
  metadata?: Record<string, string>;
  /**
   * Contract description advertised on `$SRV.INFO`
   * (`io.nats.micro.v1.info_response` `description`). Defaults to `''`.
   */
  description?: string;
  /**
   * Optional, per-method schema fingerprints (keyed by method name) advertised on
   * each endpoint's `$SRV.INFO` metadata as `dev.insler.rpc.input` /
   * `dev.insler.rpc.output` (ADR-0001 §1.4). Pure pass-through: a supplied value is
   * published, an absent one omitted; the transport never computes a fingerprint.
   */
  fingerprints?: Record<string, { input?: string; output?: string }>;
}): {
  client: NatsClientTransport;
  host: NatsHostTransport;
} {
  return {
    client: new NatsClientTransport({
      connection: options.connection,
      serde: options.serde,
      timeout: options.timeout,
      subjectPrefix: options.subjectPrefix,
      credit: options.credit,
      idleTimeout: options.idleTimeout,
      deadline: options.deadline,
    }),
    host: new NatsHostTransport({
      connection: options.connection,
      serde: options.serde,
      subjectPrefix: options.subjectPrefix,
      queue: options.queue,
      version: options.version,
      metadata: options.metadata,
      description: options.description,
      fingerprints: options.fingerprints,
      idleTimeout: options.idleTimeout,
      deadline: options.deadline,
    }),
  };
}
