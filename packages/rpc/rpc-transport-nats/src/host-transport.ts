import type {
  HostClientStreamHandler,
  HostDuplexHandler,
  HostHandler,
  HostRegistration,
  HostRequest,
  HostResponse,
  HostStreamHandler,
  HostTransport,
  HostUnregister,
} from '@insler/rpc/host';
import type { Serde } from '@insler/serde';
import { jsonBytesSerde } from '@insler/serde-json';
import type { Msg, NatsConnection, Subscription } from '@nats-io/transport-node';

import { assertValidServiceName, DiscoveryService, type EndpointInfo } from './discovery.js';
import { CreditController, grantOnConsume } from './flow-control.js';
import {
  decodeFrame,
  encodeFrame,
  type Frame,
  FrameDecodeError,
  type FrameError,
  SeqCounter,
} from './frames.js';
import { DEFAULT_IDLE_TIMEOUT_MS, startLivenessMonitor } from './liveness.js';
import { type EndpointStatsRecorder, StatsStore } from './stats.js';
import { subscribeFrames } from './streaming.js';

/**
 * Read a monotonic clock in nanoseconds (ADR-0001 §1.4 requires a monotonic source
 * for `processing_time`). Prefers `Bun.nanoseconds()`; falls back to
 * `process.hrtime.bigint()` outside Bun. Returns a `number` of nanoseconds for the
 * ADR-32 response field — well within `Number.MAX_SAFE_INTEGER` for any realistic
 * call duration (~104 days of ns).
 */
function nowNs(): number {
  const bun = (globalThis as { Bun?: { nanoseconds(): number } }).Bun;
  if (bun !== undefined) {
    return bun.nanoseconds();
  }
  return Number(process.hrtime.bigint());
}

/**
 * Build a once-guarded recorder for a single streaming CALL (issue 0012,
 * ADR-0001 §1.4). The counted unit is the call: `open` is captured here (the call
 * was accepted on this instance), and the returned `recordCall` stamps the
 * open→close duration against the per-endpoint recorder EXACTLY ONCE — every
 * streaming teardown path (graceful EndFrame, ErrorFrame, CancelFrame, idle
 * timeout) funnels through the call's `finally`, and multi-frame / both-direction
 * teardown can reach that `finally` via more than one route, so the guard prevents
 * double-counting. A graceful close passes no error (not an error); an
 * error/cancel/timeout close passes the call's terminal {@link FrameError}, which
 * increments `num_errors` and stamps `last_error`.
 */
function startCallStats(recorder: EndpointStatsRecorder | undefined): {
  recordCall: (error?: FrameError) => void;
} {
  const startNs = nowNs();
  let recorded = false;
  return {
    recordCall: (error?: FrameError): void => {
      if (recorded) {
        return;
      }
      recorded = true;
      recorder?.record({ durationNs: nowNs() - startNs, error });
    },
  };
}

export interface NatsHostTransportOptions {
  connection: NatsConnection;
  serde?: Serde<Uint8Array>;
  subjectPrefix?: string;
  queue?: string;
  /**
   * Per-call idle (stall) window in ms for streaming calls (ADR-0001 §2.7). If no
   * frame arrives on the call's `up` inbox within this window the host aborts the
   * call (stops producing on `down`, tears down `up`) — guarding a silently dead
   * client that core NATS cannot otherwise detect. Defaults to
   * {@link DEFAULT_IDLE_TIMEOUT_MS}; `0`/negative disables the idle timer.
   */
  idleTimeout?: number;
  /**
   * Optional overall deadline in ms for a streaming call (ADR-0001 §2.7): a hard
   * ceiling after which the host aborts the call. **Default off** — streams may be
   * long-lived.
   */
  deadline?: number;
  /**
   * Service version advertised on the ADR-32 discovery plane (`io.nats.micro.v1.*`
   * `version` field). Defaults to `'0.0.0'`.
   *
   * Seam note: the `@insler` contract version maps to ADR-32 `version`, but the
   * `HostRegistration` seam does not currently carry the contract version (only
   * `service` + `methods`), so the transport accepts it here. It is also reused as
   * each endpoint's `dev.insler.rpc.contract_version` on the INFO response.
   */
  version?: string;
  /** Service-level metadata advertised on discovery responses. Defaults to `{}`. */
  metadata?: Record<string, string>;
  /**
   * The contract description advertised on the ADR-32 discovery plane
   * (`io.nats.micro.v1.info_response` `description` field). Defaults to `''` (the
   * empty string) — the field is always present on the verbatim response.
   *
   * Seam note: the `@insler` contract description maps to ADR-32 `description`, but
   * the `HostRegistration` seam does not carry it (only `service` + `methods`), so
   * the transport accepts it here, mirroring how `version` is plumbed.
   */
  description?: string;
  /**
   * Optional, per-method schema fingerprints advertised on each endpoint's
   * `metadata` as `dev.insler.rpc.input` / `dev.insler.rpc.output` (ADR-0001 §1.4).
   * Keyed by method name; for each method, a supplied `input`/`output` is published
   * and an absent one is OMITTED.
   *
   * This is a pure pass-through hook: the transport publishes whatever fingerprint
   * it is given and never computes one. The fingerprint FORMAT and the
   * breaking-vs-additive compatibility semantics are a `@insler/rpc/contract` concern,
   * deferred to its own ADR (see `docs/adr/BACKLOG.md`). Defaults to none.
   */
  fingerprints?: Record<string, { input?: string; output?: string }>;
}

interface WireRequest {
  input?: unknown;
  metadata?: Record<string, string>;
}

/**
 * Coerce a thrown value into an {@link FrameError} for an `ErrorFrame`, with the
 * same exception-safety guarantee as unary: a value already shaped like a
 * classified error (`{ _tag }`) is forwarded verbatim; anything else collapses
 * to `__unknown__` so internals never leak across the wire (ADR-0001 §2.6).
 */
function toFrameError(error: unknown): FrameError {
  if (error !== null && typeof error === 'object' && '_tag' in error) {
    const classified = error as { _tag: string; payload?: unknown; message?: string };
    return { _tag: classified._tag, payload: classified.payload, message: classified.message };
  }
  return {
    _tag: '__unknown__',
    message: error instanceof Error ? error.message : 'Unknown error',
  };
}

/**
 * The streaming open envelope as it arrives on the method subject (ADR-0001
 * §2.2). For streaming kinds the request payload IS an `OpenRequest` (not a
 * unary `WireRequest`); the host knows the kind from registration and branches.
 */
interface OpenRequest {
  input?: unknown;
  metadata?: Record<string, string>;
  up: string;
  down: string;
  credit: number;
}

export class NatsHostTransport implements HostTransport {
  private readonly connection: NatsConnection;
  private readonly serde: Serde<Uint8Array>;
  private readonly subjectPrefix: string;
  private readonly queue: string;
  private readonly version: string;
  private readonly metadata: Record<string, string>;
  private readonly description: string;
  private readonly fingerprints: Record<string, { input?: string; output?: string }>;
  private readonly idleTimeout: number;
  private readonly deadline: number | undefined;

  constructor(options: NatsHostTransportOptions) {
    this.connection = options.connection;
    this.serde = options.serde ?? jsonBytesSerde;
    this.subjectPrefix = options.subjectPrefix ?? 'rpc';
    // ADR-0001 §2.1/§2.2: the method subject is queue-grouped, default `q`, so
    // unary req/reply AND the streaming OpenRequest load-balance across instances.
    this.queue = options.queue ?? 'q';
    this.version = options.version ?? '0.0.0';
    this.metadata = options.metadata ?? {};
    this.description = options.description ?? '';
    this.fingerprints = options.fingerprints ?? {};
    // Per-call liveness on `up` (ADR-0001 §2.7): idle window defaults to the
    // conservative streaming default; the overall deadline is OFF unless set.
    this.idleTimeout = options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.deadline = options.deadline;
  }

  async register(registration: HostRegistration): Promise<HostUnregister> {
    // Discovery plane: validate the service name against the ADR-32 charset BEFORE
    // standing up any subscriptions — a name that cannot be advertised must fail
    // loudly, not silently skip discovery.
    assertValidServiceName(registration.service);

    const subscriptions: Subscription[] = [];
    // Per-call `up` subscriptions opened while serving streaming calls. Tracked so
    // unregister() tears down any in-flight call's inbox (no leaks across churn).
    const callSubscriptions = new Set<{ unsubscribe(): void }>();

    // ADR-32 INFO mapping (ADR-0001 §1.1/§1.3): one endpoint per contract method.
    // The transport owns the subject layout and queue, and reads the method `kind`
    // straight off the registration. Per-endpoint metadata advertises the framework
    // descriptors, plus any SUPPLIED schema fingerprints (pass-through only).
    const endpoints: EndpointInfo[] = registration.methods.map((methodReg) => {
      const metadata: Record<string, string> = {
        'dev.insler.rpc.kind': methodReg.kind,
        'dev.insler.rpc.contract_version': this.version,
      };
      const fingerprint = this.fingerprints[methodReg.method];
      if (fingerprint?.input !== undefined) {
        metadata['dev.insler.rpc.input'] = fingerprint.input;
      }
      if (fingerprint?.output !== undefined) {
        metadata['dev.insler.rpc.output'] = fingerprint.output;
      }
      return {
        name: methodReg.method,
        subject: `${this.subjectPrefix}.${registration.service}.${methodReg.method}`,
        queue_group: this.queue,
        metadata,
      };
    });

    // Per-endpoint stats store for this registration (ADR-0001 §1.3-1.4). One
    // recorder per method, keyed by the SAME endpoint identity INFO advertises, and
    // a `started` instant stamped now (ISO-8601 UTC at $SRV.STATS time). The unary
    // serving path records each call against its recorder; the streaming paths
    // (issue 0012) plug into the SAME recorders.
    const stats = new StatsStore(
      endpoints.map((e) => ({ name: e.name, subject: e.subject, queue_group: e.queue_group }))
    );

    // ADR-32 control plane: each registration mints a unique instance `id` and
    // answers `$SRV.*` at all three scopes without a queue group (every instance
    // answers). PING, INFO, and STATS are all wired here over the shared machinery.
    const discovery = new DiscoveryService({
      connection: this.connection,
      name: registration.service,
      version: this.version,
      metadata: this.metadata,
      description: this.description,
      endpoints,
      stats,
    });
    discovery.start();

    for (const methodReg of registration.methods) {
      const subject = `${this.subjectPrefix}.${registration.service}.${methodReg.method}`;
      const subscription = this.connection.subscribe(subject, { queue: this.queue });
      subscriptions.push(subscription);

      if (methodReg.kind === 'unary') {
        // The recorder is created per endpoint above; it always exists for a
        // registered method (keyed by method name).
        const recorder = stats.recorder(methodReg.method);
        void this.processUnarySubscription(
          subscription,
          registration.service,
          methodReg.method,
          methodReg.handler,
          recorder
        );
      } else if (methodReg.kind === 'serverStream') {
        // Streaming call-level stats (issue 0012, ADR-0001 §1.4): the SAME
        // per-endpoint recorder the unary path uses (keyed by method name) — a
        // streaming call records open→close, exactly once.
        const recorder = stats.recorder(methodReg.method);
        void this.processServerStreamSubscription(
          subscription,
          registration.service,
          methodReg.method,
          methodReg.handler,
          callSubscriptions,
          recorder
        );
      } else if (methodReg.kind === 'clientStream') {
        const recorder = stats.recorder(methodReg.method);
        void this.processClientStreamSubscription(
          subscription,
          registration.service,
          methodReg.method,
          methodReg.handler,
          callSubscriptions,
          recorder
        );
      } else {
        const recorder = stats.recorder(methodReg.method);
        void this.processDuplexSubscription(
          subscription,
          registration.service,
          methodReg.method,
          methodReg.handler,
          callSubscriptions,
          recorder
        );
      }
    }

    return async () => {
      discovery.stop();
      for (const sub of subscriptions) {
        sub.unsubscribe();
      }
      // Tear down any in-flight per-call `up` inbox subscriptions.
      for (const callSub of callSubscriptions) {
        callSub.unsubscribe();
      }
      callSubscriptions.clear();
    };
  }

  private async processUnarySubscription(
    subscription: Subscription,
    service: string,
    method: string,
    handler: HostHandler,
    recorder: EndpointStatsRecorder | undefined
  ): Promise<void> {
    for await (const msg of subscription) {
      // Stats accounting (ADR-0001 §1.4): every request is one call. Measure
      // processing time with a MONOTONIC clock and classify the call as an error
      // when the response carries any reserved `__*__` tag OR a declared contract
      // error (both surface as a response `error` with a `_tag`). Recorded exactly
      // once per request, on every exit path, AFTER the response is sent.
      const startNs = nowNs();
      let outcomeError: { _tag: string; payload?: unknown; message?: string } | undefined;
      try {
        let wireRequest: WireRequest;
        try {
          wireRequest = this.serde.decode(msg.data) as WireRequest;
        } catch (err) {
          // A request whose payload cannot be decoded is a `__serde__` error: it
          // counts in stats (a response carrying a reserved tag) and sets last_error.
          outcomeError = {
            _tag: '__serde__',
            message:
              err instanceof Error
                ? `Failed to decode request: ${err.message}`
                : 'Failed to decode request',
          };
          msg.respond(this.serde.encode({ error: outcomeError }));
          continue;
        }

        const hostRequest: HostRequest = {
          service,
          method,
          kind: 'unary',
          input: wireRequest.input,
          metadata: wireRequest.metadata,
        };

        const hostResponse = await handler(hostRequest);
        // A declared contract error OR a reserved `__*__` tag both arrive as
        // `hostResponse.error` — that presence is the single error rule.
        outcomeError = hostResponse.error;
        msg.respond(
          this.serde.encode({
            output: hostResponse.output,
            error: hostResponse.error,
          })
        );
      } catch (err) {
        outcomeError = {
          _tag: '__internal__',
          message: err instanceof Error ? err.message : 'Unknown handler error',
        };
        try {
          msg.respond(this.serde.encode({ error: outcomeError }));
        } catch {
          // If we can't even encode the error, there's nothing we can do.
        }
      } finally {
        recorder?.record({ durationNs: nowNs() - startNs, error: outcomeError });
      }
    }
  }

  /**
   * serverStream host arm (ADR-0001 §2.2–2.4, happy path).
   *
   * Each open request on the method subject selects this instance (the subject is
   * queue-grouped). For each, the host subscribes the call's `up` inbox WITHOUT a
   * queue group — pinning the call to this instance — runs the registered
   * serverStream handler with a `HostRequest` built from the open envelope (the
   * unary metadata/context propagation path, reused), and publishes each output
   * as a `DataFrame` followed by exactly one terminal `EndFrame` on `down`.
   *
   * On completion the per-call `up` subscription is torn down so it never leaks.
   * (`up` carries only client control in serverStream; it is drained/ignored for
   * the happy path — credit/cancel handling is 0005/0009.)
   */
  private async processServerStreamSubscription(
    subscription: Subscription,
    service: string,
    method: string,
    handler: HostStreamHandler,
    callSubscriptions: Set<{ unsubscribe(): void }>,
    recorder: EndpointStatsRecorder | undefined
  ): Promise<void> {
    for await (const msg of subscription) {
      // Each open request spawns an independent per-call task so concurrent calls
      // to the same method don't serialize behind one another.
      void this.serveServerStreamCall(service, method, handler, msg, callSubscriptions, recorder);
    }
  }

  private async serveServerStreamCall(
    service: string,
    method: string,
    handler: HostStreamHandler,
    msg: Msg,
    callSubscriptions: Set<{ unsubscribe(): void }>,
    recorder: EndpointStatsRecorder | undefined
  ): Promise<void> {
    let open: OpenRequest;
    try {
      open = this.serde.decode(msg.data) as OpenRequest;
    } catch {
      // A decode failure on the open request leaves us no inboxes to report on;
      // there is nothing to publish to. Drop it (a malformed open is a client
      // bug); error-frame reporting for in-band failures is issue 0006. The call
      // was never accepted on this instance, so it is NOT counted in stats.
      return;
    }

    // Streaming call-level stats (issue 0012, ADR-0001 §1.4): the call is now
    // accepted on this instance — start the open→close timer. `callError` captures
    // the call's terminal so the `finally` can record once: a graceful EndFrame
    // close leaves it undefined (not an error); an ErrorFrame/CancelFrame/timeout
    // close sets it (→ num_errors + last_error).
    const { recordCall } = startCallStats(recorder);
    let callError: FrameError | undefined;

    const seq = new SeqCounter();
    const publishFrame = (frame: Parameters<typeof encodeFrame>[1]): void => {
      this.connection.publish(open.down, encodeFrame(this.serde, frame));
    };

    // Flow control on `down` (ADR-0001 §2.5): the host is the SENDER on `down`,
    // so it meters its output against a credit window. The client grants the
    // initial window in `OpenRequest.credit` and replenishes it with a
    // `CreditFrame` on `up` per item it consumes. At credit 0 the host pauses
    // (acquire parks) and resumes on the next grant — pushing the consumer's
    // backpressure across the wire instead of buffering output in the host.
    const downCredit = new CreditController(open.credit);

    // Whether the call has been aborted from the client side (a `CancelFrame` /
    // `ErrorFrame` on `up`) or by a liveness expiry. Once set, the host stops
    // pulling the handler and producing on `down` — the peer stops sending, which
    // is the cancel/timeout teardown guarantee (ADR-0001 §2.7).
    let aborted = false;

    // Subscribe the call's `up` inbox (no queue group — pins the call here). For
    // serverStream, `up` carries client control only; here we route inbound
    // `CreditFrame`s into the `down` window. (clientStream/duplex also carry `up`
    // DataFrames — issues 0007/0008 — which reuse this same subscription.)
    const upSub = subscribeFrames<Frame>(this.connection, open.up, (data) =>
      decodeFrame(this.serde, data)
    );
    callSubscriptions.add(upSub);

    // Per-call liveness on `up` (ADR-0001 §2.7): a silently dead client trips the
    // idle timer (or the optional deadline). On expiry we abort (stop producing on
    // `down`, releasing a host parked at credit 0) and tear down `up` — that wakes
    // the `drainUp` loop so the call completes promptly rather than hanging.
    // `notify()` resets the idle window on each `up` frame.
    const liveness = startLivenessMonitor({
      idleTimeout: this.idleTimeout,
      deadline: this.deadline,
      onExpire: (reason) => {
        aborted = true;
        // The call's terminal is a host-side idle/deadline timeout (ADR-0001 §2.7):
        // it counts as an error in stats (issue 0012).
        callError = {
          _tag: '__timeout__',
          message:
            reason === 'idle'
              ? `Stream idle for ${this.idleTimeout}ms (no frame on 'up')`
              : `Stream exceeded overall deadline of ${this.deadline}ms`,
        };
        downCredit.cancel();
        upSub.unsubscribe();
      },
    });

    // Drain `up` for control frames concurrently with producing on `down`. A
    // `CreditFrame` grants the `down` window; this is what wakes a host paused at
    // credit 0. The loop ends when `up` is torn down on completion.
    const drainUp = (async (): Promise<void> => {
      try {
        for await (const frame of upSub.frames) {
          // A frame arrived: reset the idle window (ADR-0001 §2.7).
          liveness.notify();
          if (frame.t === 'c') {
            downCredit.grant(frame.n);
          } else if (frame.t === 'x' || frame.t === 'a') {
            // Terminal frame on `up` (ADR-0001 §2.4/§2.6): an `ErrorFrame` or
            // `CancelFrame` from the client aborts the whole call in both
            // directions. The host stops sending — abort the output loop and
            // release any producer parked at credit 0 — so the call tears down
            // promptly rather than running the handler to completion.
            aborted = true;
            // Stats (issue 0012): a client ErrorFrame/CancelFrame close counts as
            // an error. Forward the frame's error verbatim, or synthesize one for a
            // bare CancelFrame.
            callError =
              frame.t === 'x'
                ? frame.error
                : { _tag: '__transport__', message: 'Stream cancelled by client' };
            downCredit.cancel();
            return;
          }
          // `up` `DataFrame`/`EndFrame` are client-input for clientStream/duplex
          // (issues 0007/0008); serverStream's `up` carries only control.
        }
      } catch {
        // `up` subscription error (decode fault / early close): stop metering so
        // the producer doesn't hang. The call tears down via the `finally` below.
        aborted = true;
        // Stats (issue 0012): an `up` fault that aborts the call is an error close,
        // unless a more specific terminal was already captured.
        callError ??= { _tag: '__transport__', message: "Stream 'up' channel error" };
        downCredit.cancel();
      }
    })();

    const hostRequest: HostRequest = {
      service,
      method,
      kind: 'serverStream',
      input: open.input,
      metadata: open.metadata,
    };

    try {
      const responseStream: AsyncIterable<HostResponse> = handler(hostRequest);
      for await (const response of responseStream) {
        // Mid-stream error mapping (ADR-0001 §2.6, parity with unary): the host
        // wrapper (`wrapServerStreamHandler`) has already classified a thrown
        // error into a `HostResponse.error` — a DECLARED contract error keeps its
        // `{ _tag, payload, message }`; an UNDECLARED throw collapses to
        // `__unknown__` (internals never leak). When such a response arrives we
        // emit an `ErrorFrame` — terminal for the whole call — INSTEAD of a
        // DataFrame, and stop. The EndFrame is superseded; already-published
        // DataFrames remain delivered. Error frames are control, not credit-gated.
        if (aborted) {
          // The client cancelled (or a liveness timer fired) while we held this
          // output: stop pulling the handler. The peer stops sending — no further
          // DataFrame and no graceful EndFrame (the call is aborted, not completed).
          return;
        }
        if (response.error) {
          // Stats (issue 0012): a host ErrorFrame close counts as an error.
          callError = response.error;
          publishFrame({ t: 'x', error: response.error });
          return;
        }
        // Flow control: reserve one credit BEFORE publishing. When the window is
        // exhausted this parks until the client's next `CreditFrame`, bounding
        // the host's output in flight to the credit window (no unbounded
        // buffering). The await also paces the handler's own production — the
        // generator does not advance past a `yield` until we publish it.
        await downCredit.acquire();
        // `acquire()` may have resolved BECAUSE the window was cancelled on abort
        // (cancel resolves parked acquirers). Re-check before publishing so a
        // cancelled call never emits another DataFrame.
        if (aborted) {
          return;
        }
        publishFrame({ t: 'd', seq: seq.take(), data: response.output });
      }
      // Graceful half-close: exactly one terminal EndFrame on `down` — only when
      // the call completed normally (not aborted).
      if (!aborted) {
        publishFrame({ t: 'e', seq: seq.take() });
      }
    } catch (error) {
      // The host stream wrapper catches handler throws and surfaces them as a
      // `HostResponse.error` (handled above), so reaching here means the failure
      // is BELOW that wrapper — typically an unwrapped registration (the host
      // transport's own arms) throwing. Map it to an `ErrorFrame` so the client
      // surfaces a typed error rather than hanging, never leaking internals: a
      // value already shaped `{ _tag }` rides through (it is a classified error),
      // anything else collapses to `__unknown__`.
      const frameError = toFrameError(error);
      // Stats (issue 0012): a below-wrapper failure that ends the call with an
      // ErrorFrame counts as an error.
      callError = frameError;
      try {
        publishFrame({ t: 'x', error: frameError });
      } catch {
        // Connection gone; nothing more to do.
      }
    } finally {
      // Stop the liveness monitor (a finished call must not fire a late timeout),
      // release any parked producer, and stop draining `up` before tearing down.
      liveness.stop();
      downCredit.cancel();
      upSub.unsubscribe();
      callSubscriptions.delete(upSub);
      await drainUp;
      // Stats (issue 0012, ADR-0001 §1.4): record the CALL exactly once at close
      // (open→close duration), with the captured terminal — undefined for a
      // graceful EndFrame close (not an error), or the call's error/cancel/timeout.
      recordCall(callError);
    }
  }

  /**
   * clientStream host arm (ADR-0001 §2.2-2.6).
   *
   * The mirror of {@link processServerStreamSubscription}, metering the OTHER
   * direction. Each open request selects this instance (queue-grouped); for each,
   * the host subscribes the call's `up` inbox (no queue group — pinning the call),
   * exposes the inbound `up` `DataFrame`s as the input `AsyncIterable` the
   * registered clientStream handler consumes, then publishes the handler's single
   * output as one `DataFrame` followed by exactly one terminal `EndFrame` on
   * `down` (the `down` `EndFrame` is call completion).
   */
  private async processClientStreamSubscription(
    subscription: Subscription,
    service: string,
    method: string,
    handler: HostClientStreamHandler,
    callSubscriptions: Set<{ unsubscribe(): void }>,
    recorder: EndpointStatsRecorder | undefined
  ): Promise<void> {
    for await (const msg of subscription) {
      // Each open request spawns an independent per-call task so concurrent calls
      // to the same method don't serialize behind one another.
      void this.serveClientStreamCall(service, method, handler, msg, callSubscriptions, recorder);
    }
  }

  private async serveClientStreamCall(
    service: string,
    method: string,
    handler: HostClientStreamHandler,
    msg: Msg,
    callSubscriptions: Set<{ unsubscribe(): void }>,
    recorder: EndpointStatsRecorder | undefined
  ): Promise<void> {
    let open: OpenRequest;
    try {
      open = this.serde.decode(msg.data) as OpenRequest;
    } catch {
      // A malformed open leaves no inboxes to report on; drop it. The call was
      // never accepted on this instance, so it is NOT counted in stats.
      return;
    }

    // Streaming call-level stats (issue 0012, ADR-0001 §1.4): the call is accepted
    // on this instance — start the open→close timer. `callError` captures the
    // call's terminal so the `finally` records once.
    const { recordCall } = startCallStats(recorder);
    let callError: FrameError | undefined;

    const seq = new SeqCounter();
    const publishFrame = (frame: Parameters<typeof encodeFrame>[1]): void => {
      this.connection.publish(open.down, encodeFrame(this.serde, frame));
    };

    // Subscribe the call's `up` inbox (no queue group — pins the call here). It
    // carries the client's input `DataFrame`s and its terminal `EndFrame`.
    const upSub = subscribeFrames<Frame>(this.connection, open.up, (data) =>
      decodeFrame(this.serde, data)
    );
    callSubscriptions.add(upSub);

    // Flow control on `up` (ADR-0001 §2.5): the host is the RECEIVER, so it grants
    // the client a window and replenishes it as the handler consumes inputs. The
    // initial window is granted up front on `down` (a `CreditFrame`); thereafter
    // `grantOnConsume` grants one per consumed input. This bounds the client's
    // in-flight input under a slow host consumer. The initial `up` window is the
    // client's `OpenRequest.credit` (the client's grant on `down`, reused as the
    // `up` window so a single knob configures both directions).
    const initialUpCredit = open.credit;
    publishFrame({ t: 'c', n: initialUpCredit });
    const grantOneUp = (): void => {
      publishFrame({ t: 'c', n: 1 });
    };

    // The terminal error/cancel the client may send on `up`, captured so the input
    // generator can throw it into the handler's consuming loop (ADR-0001 §2.6).
    let upTerminalError: FrameError | undefined;

    // Per-call liveness on `up` (ADR-0001 §2.7): a silently dead client trips the
    // idle timer (or the optional deadline). On expiry we mark the timeout and tear
    // down `up` — that ends the `rawInput` loop, which then throws the captured
    // `__timeout__` into the handler's consuming `for await`, failing the call.
    const liveness = startLivenessMonitor({
      idleTimeout: this.idleTimeout,
      deadline: this.deadline,
      onExpire: (reason) => {
        upTerminalError = {
          _tag: '__timeout__',
          message:
            reason === 'idle'
              ? `Stream idle for ${this.idleTimeout}ms (no frame on 'up')`
              : `Stream exceeded overall deadline of ${this.deadline}ms`,
        };
        upSub.unsubscribe();
      },
    });

    // Build the input `AsyncIterable` the handler consumes from `up` frames: yield
    // each DataFrame's `data` (in seq order — a gap is a transport fault), stop at
    // the client's `EndFrame` (half-close). An `ErrorFrame`/`CancelFrame` from the
    // client is terminal for the whole call.
    let expectedSeq = 0;
    const rawInput = (async function* (): AsyncIterable<unknown> {
      for await (const frame of upSub.frames) {
        // A frame arrived: reset the idle window (ADR-0001 §2.7).
        liveness.notify();
        if (frame.t === 'd') {
          if (frame.seq !== expectedSeq) {
            throw { _tag: '__transport__', message: `Stream frame sequence gap on 'up'` };
          }
          expectedSeq += 1;
          yield frame.data;
        } else if (frame.t === 'e') {
          // Half-close on `up`: the client has no more input. Complete the input
          // iterable so the handler's `for await` ends and it can aggregate.
          return;
        } else if (frame.t === 'x') {
          // Terminal ErrorFrame from the client aborts the whole call.
          upTerminalError = frame.error;
          throw frame.error;
        } else if (frame.t === 'a') {
          // CancelFrame from the client aborts the whole call.
          upTerminalError = { _tag: '__transport__', message: 'Stream cancelled by client' };
          throw upTerminalError;
        }
        // `up` `CreditFrame` is not expected for clientStream (the host grants on
        // `down`); ignore it.
      }
      // `up` subscription ended without an EndFrame. If a liveness timer fired, the
      // captured `__timeout__` is terminal (ADR-0001 §2.7); otherwise it is an early
      // close / teardown → a transport fault so a half-consumed handler doesn't hang.
      if (upTerminalError !== undefined) {
        throw upTerminalError;
      }
      throw { _tag: '__transport__', message: "Stream 'up' channel closed before half-close" };
    })();

    // Replenish one `up` credit as each input is CONSUMED by the handler (not on
    // arrival): a slow handler keeps the client's in-flight input bounded.
    const inputStream = grantOnConsume<unknown>(rawInput, () => true, grantOneUp);

    const hostRequest: HostRequest = {
      service,
      method,
      kind: 'clientStream',
      metadata: open.metadata,
    };

    try {
      const response = await handler(hostRequest, inputStream);
      if (response.error) {
        // The handler wrapper classified a thrown error (declared contract error
        // keeps its `{ _tag, payload, message }`; an undeclared throw collapses to
        // `__unknown__`). Surface it as a terminal ErrorFrame on `down`.
        // Stats (issue 0012): a host ErrorFrame close counts as an error.
        callError = response.error;
        publishFrame({ t: 'x', error: response.error });
      } else if (upTerminalError !== undefined) {
        // The client aborted mid-stream (ErrorFrame/CancelFrame on `up`); the
        // handler may have returned a value anyway. The call is terminal — forward
        // the client's terminal as the down ErrorFrame rather than a stale output.
        // Stats (issue 0012): a client error/cancel/timeout close counts as an error.
        callError = upTerminalError;
        publishFrame({ t: 'x', error: upTerminalError });
      } else {
        // The host's single output `DataFrame`, then the terminal `EndFrame` on
        // `down` (call completion, ADR-0001 §2.4). Graceful close — not an error.
        publishFrame({ t: 'd', seq: seq.take(), data: response.output });
        publishFrame({ t: 'e', seq: seq.take() });
      }
    } catch (error) {
      // The clientStream handler wrapper catches handler throws and returns a
      // `HostResponse.error` (handled above), so reaching here is a failure below
      // that wrapper. Map it to an `ErrorFrame`, never leaking internals.
      // Stats (issue 0012): a below-wrapper ErrorFrame close counts as an error;
      // prefer the client's terminal if one was already captured.
      const frameError = upTerminalError ?? toFrameError(error);
      callError = frameError;
      try {
        publishFrame({ t: 'x', error: frameError });
      } catch {
        // Connection gone; nothing more to do.
      }
    } finally {
      // Stop the liveness monitor so a finished call never fires a late timeout.
      liveness.stop();
      upSub.unsubscribe();
      callSubscriptions.delete(upSub);
      // Stats (issue 0012, ADR-0001 §1.4): record the CALL exactly once at close
      // (open→close), with the captured terminal (undefined for a graceful close).
      recordCall(callError);
    }
  }

  /**
   * duplex host arm (ADR-0001 §2.2/§2.4).
   *
   * The union of the serverStream and clientStream arms: both directions stream
   * INDEPENDENTLY and CONCURRENTLY over the call's two inboxes. Each open request
   * selects this instance (queue-grouped); for each, the host subscribes the call's
   * `up` inbox (no queue group — pinning the call) and runs the registered duplex
   * handler over the inbound input `AsyncIterable`, publishing the handler's outputs
   * as `DataFrame`s on `down`. Each direction half-closes with its OWN `EndFrame`,
   * and an `ErrorFrame`/`CancelFrame` tears down both.
   */
  private async processDuplexSubscription(
    subscription: Subscription,
    service: string,
    method: string,
    handler: HostDuplexHandler,
    callSubscriptions: Set<{ unsubscribe(): void }>,
    recorder: EndpointStatsRecorder | undefined
  ): Promise<void> {
    for await (const msg of subscription) {
      // Each open request spawns an independent per-call task so concurrent calls
      // to the same method don't serialize behind one another.
      void this.serveDuplexCall(service, method, handler, msg, callSubscriptions, recorder);
    }
  }

  private async serveDuplexCall(
    service: string,
    method: string,
    handler: HostDuplexHandler,
    msg: Msg,
    callSubscriptions: Set<{ unsubscribe(): void }>,
    recorder: EndpointStatsRecorder | undefined
  ): Promise<void> {
    let open: OpenRequest;
    try {
      open = this.serde.decode(msg.data) as OpenRequest;
    } catch {
      // A malformed open leaves no inboxes to report on; drop it. The call was
      // never accepted on this instance, so it is NOT counted in stats.
      return;
    }

    // Streaming call-level stats (issue 0012, ADR-0001 §1.4): the call is accepted
    // on this instance — start the open→close timer. `callError` captures the
    // call's terminal so the `finally` records once.
    const { recordCall } = startCallStats(recorder);
    let callError: FrameError | undefined;

    const seq = new SeqCounter();
    const publishFrame = (frame: Parameters<typeof encodeFrame>[1]): void => {
      this.connection.publish(open.down, encodeFrame(this.serde, frame));
    };

    // Subscribe the call's `up` inbox (no queue group — pins the call here). It
    // multiplexes BOTH the client's input `DataFrame`s/`EndFrame`/terminal AND the
    // client's `CreditFrame`s replenishing the host's `down` (output) window.
    const upSub = subscribeFrames<Frame>(this.connection, open.up, (data) =>
      decodeFrame(this.serde, data)
    );
    callSubscriptions.add(upSub);

    // `down` flow control (ADR-0001 §2.5): the host is the SENDER on `down`, so it
    // meters its output against a window the CLIENT grants. The client grants the
    // initial window in `OpenRequest.credit` and replenishes it with a `CreditFrame`
    // on `up` per output it consumes. This is INDEPENDENT of the `up` window below.
    const downCredit = new CreditController(open.credit);

    // `up` flow control (ADR-0001 §2.5): the host is the RECEIVER on `up`, so it
    // grants the client a window and replenishes it as the handler consumes inputs.
    // The initial `up` window is granted up front on `down` (a `CreditFrame`) — this
    // ALSO doubles as the 0007 host-ready signal that the client waits for before
    // publishing any `up` frame. Reuse the client's `OpenRequest.credit` as the `up`
    // window so a single knob configures both directions.
    publishFrame({ t: 'c', n: open.credit });
    const grantOneUp = (): void => {
      publishFrame({ t: 'c', n: 1 });
    };

    // The terminal error/cancel the client may send on `up`, captured so the input
    // generator can throw it into the handler's consuming loop (ADR-0001 §2.6).
    let upTerminalError: FrameError | undefined;
    // Whether the whole call has reached a terminal (error/cancel either side);
    // releases the parked `down` producer so it stops promptly.
    let terminated = false;

    // `up` multiplexes the client's INPUT frames (for the handler's input stream)
    // AND its `CreditFrame`s replenishing the host's `down` (output) window. These
    // two concerns have DIFFERENT lifetimes: the input stream ends at the client's
    // `up` `EndFrame`, but `down` may keep producing afterward and still needs the
    // client's `down` CreditFrames. So a SINGLE dedicated drain owns the `up`
    // iterator for the WHOLE call: it routes CreditFrames into `downCredit` and
    // hands input frames to the input queue below. (A naive "drain only while the
    // input generator is pulled" deadlocks: after `up` half-closes, nobody reads
    // `up`, so the client's `down` CreditFrames never arrive and the `down`
    // producer parks at credit 0 forever.)

    // A bounded one-slot async hand-off from the `up` drain to the input generator:
    // each pull resolves with the next input item, end-of-input, or a terminal.
    type InputSignal =
      | { kind: 'data'; data: unknown }
      | { kind: 'end' }
      | { kind: 'error'; error: unknown };
    const inputQueue: InputSignal[] = [];
    let inputPending: ((s: InputSignal) => void) | null = null;
    const deliverInput = (signal: InputSignal): void => {
      if (inputPending) {
        const resolve = inputPending;
        inputPending = null;
        resolve(signal);
      } else {
        inputQueue.push(signal);
      }
    };
    const nextInput = (): Promise<InputSignal> => {
      const head = inputQueue.shift();
      if (head) {
        return Promise.resolve(head);
      }
      return new Promise<InputSignal>((resolve) => {
        inputPending = resolve;
      });
    };

    // Per-call liveness on `up` (ADR-0001 §2.7): a silently dead client trips the
    // idle timer (or the optional deadline). On expiry abort the WHOLE call —
    // release the parked `down` producer, deliver a `__timeout__` terminal to the
    // handler's input stream, and tear down `up` (which ends the drain). `notify()`
    // resets the idle window on each `up` frame.
    const liveness = startLivenessMonitor({
      idleTimeout: this.idleTimeout,
      deadline: this.deadline,
      onExpire: (reason) => {
        upTerminalError = {
          _tag: '__timeout__',
          message:
            reason === 'idle'
              ? `Stream idle for ${this.idleTimeout}ms (no frame on 'up')`
              : `Stream exceeded overall deadline of ${this.deadline}ms`,
        };
        terminated = true;
        downCredit.cancel();
        deliverInput({ kind: 'error', error: upTerminalError });
        upSub.unsubscribe();
      },
    });

    // The dedicated `up` drain, owning the iterator for the whole call lifetime.
    let expectedSeq = 0;
    const drainUp = (async (): Promise<void> => {
      try {
        for await (const frame of upSub.frames) {
          // A frame arrived: reset the idle window (ADR-0001 §2.7).
          liveness.notify();
          if (frame.t === 'c') {
            // Client granting the host's `down` (output) window.
            downCredit.grant(frame.n);
          } else if (frame.t === 'd') {
            if (frame.seq !== expectedSeq) {
              deliverInput({
                kind: 'error',
                error: { _tag: '__transport__', message: `Stream frame sequence gap on 'up'` },
              });
              return;
            }
            expectedSeq += 1;
            deliverInput({ kind: 'data', data: frame.data });
          } else if (frame.t === 'e') {
            // Half-close on `up`: the client has no more input. The input stream
            // ends — but the call is NOT over; the handler may keep producing on
            // `down`. Keep draining for `down` CreditFrames after signalling end.
            deliverInput({ kind: 'end' });
          } else if (frame.t === 'x') {
            // Terminal ErrorFrame from the client aborts the WHOLE call.
            upTerminalError = frame.error;
            terminated = true;
            downCredit.cancel();
            deliverInput({ kind: 'error', error: frame.error });
            return;
          } else if (frame.t === 'a') {
            // CancelFrame from the client aborts the WHOLE call.
            upTerminalError = { _tag: '__transport__', message: 'Stream cancelled by client' };
            terminated = true;
            downCredit.cancel();
            deliverInput({ kind: 'error', error: upTerminalError });
            return;
          }
        }
        // `up` ended (teardown / early close). If the input stream is still open,
        // surface a transport fault so a half-consumed handler does not hang; once
        // teardown begins this is expected and harmless.
        if (!terminated) {
          deliverInput({
            kind: 'error',
            error: {
              _tag: '__transport__',
              message: "Stream 'up' channel closed before half-close",
            },
          });
        }
      } catch (err) {
        // A decode fault / subscription error on `up` (FrameDecodeError → __serde__).
        const error =
          err instanceof FrameDecodeError
            ? { _tag: '__serde__', message: err.message }
            : {
                _tag: '__transport__',
                message: err instanceof Error ? err.message : "Stream 'up' transport error",
              };
        terminated = true;
        downCredit.cancel();
        deliverInput({ kind: 'error', error });
      }
    })();

    // The input `AsyncIterable` the handler consumes — pulls from the drain's queue,
    // ending at the client's `up` `EndFrame` and throwing on a terminal/fault.
    const rawInput = (async function* (): AsyncIterable<unknown> {
      while (true) {
        const signal = await nextInput();
        if (signal.kind === 'data') {
          yield signal.data;
        } else if (signal.kind === 'end') {
          return;
        } else {
          throw signal.error;
        }
      }
    })();

    // Replenish one `up` credit as each input is CONSUMED by the handler (not on
    // arrival): a slow handler keeps the client's in-flight input bounded.
    const inputStream = grantOnConsume<unknown>(rawInput, () => true, grantOneUp);

    const hostRequest: HostRequest = {
      service,
      method,
      kind: 'duplex',
      metadata: open.metadata,
    };

    try {
      // The `down` half: iterate the handler's output stream, metering it against
      // the `down` window, and publish each output as a DataFrame followed by a
      // single terminal EndFrame. The handler reads the input stream above
      // concurrently — both directions run independently.
      const responseStream: AsyncIterable<HostResponse> = handler(hostRequest, inputStream);
      for await (const response of responseStream) {
        if (response.error) {
          // Mid-stream error mapping (ADR-0001 §2.6, parity with unary): the host
          // wrapper classified a thrown error into a `HostResponse.error` — a
          // declared contract error keeps its `{ _tag, payload, message }`; an
          // undeclared throw collapses to `__unknown__`. Emit a terminal ErrorFrame
          // INSTEAD of a DataFrame and stop. Already-published outputs stay delivered.
          terminated = true;
          downCredit.cancel();
          // Stats (issue 0012): a host ErrorFrame close counts as an error.
          callError = response.error;
          publishFrame({ t: 'x', error: response.error });
          return;
        }
        // Reserve one `down` credit before publishing; parks at credit 0 until the
        // client's next `CreditFrame`, bounding the host's in-flight output.
        await downCredit.acquire();
        if (terminated) {
          // Released by a terminal (client cancel/error/timeout). Capture it so the
          // close is counted as an error even though the output loop exits here
          // without re-reaching the post-loop branch.
          callError ??= upTerminalError;
          return;
        }
        publishFrame({ t: 'd', seq: seq.take(), data: response.output });
      }
      if (upTerminalError !== undefined) {
        // The client aborted `up` mid-stream (ErrorFrame/CancelFrame); the call is
        // terminal — forward the client's terminal as the down ErrorFrame rather
        // than a graceful EndFrame.
        // Stats (issue 0012): a client error/cancel/timeout close counts as an error.
        callError = upTerminalError;
        publishFrame({ t: 'x', error: upTerminalError });
      } else {
        // Graceful half-close on `down`: exactly one terminal EndFrame — not an error.
        publishFrame({ t: 'e', seq: seq.take() });
      }
    } catch (error) {
      // The duplex handler wrapper catches handler throws and yields a
      // `HostResponse.error` (handled above), so reaching here is a failure below
      // that wrapper (e.g. the input generator threw a `{ _tag }`). Map it to an
      // ErrorFrame, never leaking internals.
      // Stats (issue 0012): a below-wrapper ErrorFrame close counts as an error;
      // prefer a captured client terminal if one exists.
      const frameError = upTerminalError ?? toFrameError(error);
      callError = frameError;
      try {
        publishFrame({ t: 'x', error: frameError });
      } catch {
        // Connection gone; nothing more to do.
      }
    } finally {
      // Stop the liveness monitor (a finished call must not fire a late timeout),
      // then tear down BOTH directions: release any parked `down` producer, stop the
      // `up` drain (unsubscribing wakes it so it completes), and unsubscribe the
      // per-call `up` inbox (no leaks). Wake a parked input pull so a half-consumed
      // generator does not hang during teardown.
      liveness.stop();
      terminated = true;
      downCredit.cancel();
      upSub.unsubscribe();
      callSubscriptions.delete(upSub);
      deliverInput({ kind: 'end' });
      await drainUp;
      // Stats (issue 0012, ADR-0001 §1.4): record the CALL exactly once at close
      // (open→close), with the captured terminal (undefined for a graceful close).
      recordCall(callError);
    }
  }
}
