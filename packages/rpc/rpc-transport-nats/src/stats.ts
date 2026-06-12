/**
 * Per-endpoint stats accounting for the ADR-32 discovery plane (ADR-0001 §1.3-1.4).
 *
 * The host transport maintains, per endpoint, the ADR-32 `EndpointStats` counters
 * (`num_requests`, `num_errors`, `last_error`, total `processing_time` in ns) and the
 * service-level `started` timestamp. `$SRV.STATS` reads them back as the verbatim
 * `io.nats.micro.v1.stats_response` (see {@link DiscoveryService}).
 *
 * Counting unit & error rule (ADR-0001 §1.4):
 * - The counted unit is a **call**: a unary request/reply, and (issue 0012) a
 *   streaming call measured open→close. Every recorded call increments
 *   `num_requests` and accumulates its `processing_time` (nanoseconds).
 * - A call is an **error** when its response carries any reserved `__*__` tag OR a
 *   declared contract error. In both cases the host produces a `HostResponse.error`
 *   with a `_tag`, so "the response carried an error" is the single detection rule;
 *   the recorder takes the classified error and stamps `last_error`.
 *
 * Time base: callers measure elapsed time with a MONOTONIC clock
 * (`Bun.nanoseconds()` / `process.hrtime.bigint()`) and pass nanoseconds in. The
 * recorder never reads a clock itself, so it stays trivially testable and the
 * unary and (0012) streaming paths share one accounting seam.
 *
 * Seam for streaming (issue 0012): the streaming call paths record exactly the same
 * way — one {@link EndpointStatsRecorder.record} per call, with the open→close
 * duration in ns and `isError`/`error` derived from the call's terminal
 * (`ErrorFrame`/`CancelFrame`). No new counter shape is needed; 0012 plugs into the
 * same per-endpoint recorder the {@link StatsStore} hands out here.
 */

import type { FrameError } from './frames.js';

/** A classified error as it rides a `HostResponse.error` / an `ErrorFrame`. */
export type RecordedError = { _tag: string; payload?: unknown; message?: string };

/** The outcome of one call, as the recorder needs it. */
export interface CallOutcome {
  /** Elapsed processing time for the call, in NANOSECONDS (monotonic). */
  durationNs: number;
  /**
   * The call's error, if any. Presence means the call counts as an error
   * (increments `num_errors` and stamps `last_error`). A declared contract error or
   * any reserved `__*__` tag both arrive here as a classified `{ _tag, ... }`.
   */
  error?: RecordedError | FrameError;
}

/**
 * The verbatim ADR-32 `EndpointStats` (ADR-0001 §1.3). `processing_time` /
 * `average_processing_time` are in NANOSECONDS. `last_error` / `data` are present
 * only when set, mirroring ADR-32's optional fields.
 */
export interface EndpointStats {
  name: string;
  subject: string;
  queue_group: string;
  num_requests: number;
  num_errors: number;
  last_error?: string;
  data?: unknown;
  processing_time: number;
  average_processing_time: number;
}

/** The static endpoint identity (shared with the INFO endpoint), keyed for stats. */
export interface EndpointIdentity {
  name: string;
  subject: string;
  queue_group: string;
}

/**
 * Mutable per-endpoint counters. One per registered method; the unary path and the
 * (0012) streaming paths both call {@link record} against the SAME instance so a
 * method's unary and streaming calls accumulate into one set of counters.
 */
export class EndpointStatsRecorder {
  readonly name: string;
  readonly subject: string;
  readonly queue_group: string;

  private numRequests = 0;
  private numErrors = 0;
  private totalProcessingTimeNs = 0;
  private lastError: string | undefined;

  constructor(identity: EndpointIdentity) {
    this.name = identity.name;
    this.subject = identity.subject;
    this.queue_group = identity.queue_group;
  }

  /**
   * Record one completed call against this endpoint (ADR-0001 §1.4). Increments
   * `num_requests`, accumulates `processing_time` (ns), and — when the call carried
   * an error — increments `num_errors` and updates `last_error`.
   */
  record(outcome: CallOutcome): void {
    this.numRequests += 1;
    // Guard against a negative/NaN duration (a clock anomaly) so the totals stay
    // monotonic and `average` stays a real number.
    if (Number.isFinite(outcome.durationNs) && outcome.durationNs > 0) {
      this.totalProcessingTimeNs += outcome.durationNs;
    }
    if (outcome.error !== undefined) {
      this.numErrors += 1;
      this.lastError = formatLastError(outcome.error);
    }
  }

  /** Snapshot the current counters as the verbatim ADR-32 `EndpointStats`. */
  snapshot(): EndpointStats {
    const stats: EndpointStats = {
      name: this.name,
      subject: this.subject,
      queue_group: this.queue_group,
      num_requests: this.numRequests,
      num_errors: this.numErrors,
      // Integer nanoseconds; `average` is total/count, 0 when there are no calls.
      processing_time: this.totalProcessingTimeNs,
      average_processing_time:
        this.numRequests === 0 ? 0 : Math.round(this.totalProcessingTimeNs / this.numRequests),
    };
    if (this.lastError !== undefined) {
      stats.last_error = this.lastError;
    }
    return stats;
  }
}

/**
 * Owns the per-endpoint recorders for one `register()` and the service-level
 * `started` timestamp (ADR-0001 §1.3). The host builds one store per registration
 * (one recorder per method, in registration order), hands the matching recorder to
 * each method's serving path, and passes the store to {@link DiscoveryService} so
 * `$SRV.STATS` can snapshot it.
 */
export class StatsStore {
  /** ISO-8601 UTC instant the service registered (ADR-32 `started`). */
  readonly started: string;

  private readonly recorders: EndpointStatsRecorder[] = [];
  private readonly byName = new Map<string, EndpointStatsRecorder>();

  /**
   * @param endpoints endpoint identities in registration (endpoint) order.
   * @param startedAt the registration instant; defaults to now. ISO-8601 UTC.
   */
  constructor(endpoints: EndpointIdentity[], startedAt: Date = new Date()) {
    this.started = startedAt.toISOString();
    for (const identity of endpoints) {
      const recorder = new EndpointStatsRecorder(identity);
      this.recorders.push(recorder);
      this.byName.set(identity.name, recorder);
    }
  }

  /** The recorder for a method, by endpoint name. Undefined for an unknown method. */
  recorder(name: string): EndpointStatsRecorder | undefined {
    return this.byName.get(name);
  }

  /** Snapshot every endpoint's stats, in registration order. */
  snapshot(): EndpointStats[] {
    return this.recorders.map((r) => r.snapshot());
  }
}

/**
 * Render a classified error into the single-string `last_error` ADR-32 carries.
 * Keeps the tag (so the reserved `__*__` vocabulary surfaces) and appends the
 * message when present, e.g. `__validation__: amount must be a number` or a bare
 * declared tag like `insufficient_funds`.
 */
function formatLastError(error: RecordedError | FrameError): string {
  const tag = typeof error._tag === 'string' ? error._tag : '__unknown__';
  if (typeof error.message === 'string' && error.message.length > 0) {
    return `${tag}: ${error.message}`;
  }
  return tag;
}
