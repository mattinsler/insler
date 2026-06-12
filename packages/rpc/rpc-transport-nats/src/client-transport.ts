import type { ClientRequest, ClientResponse, ClientTransport } from '@insler/rpc/client';
import type { Serde } from '@insler/serde';
import { jsonBytesSerde } from '@insler/serde-json';
import type { NatsConnection } from '@nats-io/transport-node';

import { CreditController, grantOnConsume } from './flow-control.js';
import { decodeFrame, encodeFrame, type Frame, FrameDecodeError, SeqCounter } from './frames.js';
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  type LivenessExpiry,
  startLivenessMonitor,
  TIMEOUT_TAG,
} from './liveness.js';
import { allocateCallInboxes, subscribeFrames } from './streaming.js';

export interface NatsClientTransportOptions {
  connection: NatsConnection;
  serde?: Serde<Uint8Array>;
  timeout?: number;
  subjectPrefix?: string;
  /**
   * Initial credit the client grants the host on `down` (the `down` window): the
   * host may have at most this many un-acked `DataFrame`s in flight before it
   * pauses. The client replenishes the window with a `CreditFrame` per item it
   * consumes (ADR-0001 §2.5). Defaults to {@link DEFAULT_CREDIT} — a large window
   * that effectively never throttles; set a small value to bound buffering
   * tightly (and to make the bound observable in tests).
   */
  credit?: number;
  /**
   * Per-call idle (stall) window in ms for streaming calls (ADR-0001 §2.7). If no
   * frame (data *or* control) arrives on `down` within this window the call fails
   * with `__timeout__` and both inboxes are torn down — guarding a silently dead
   * host that core NATS cannot otherwise detect. Defaults to
   * {@link DEFAULT_IDLE_TIMEOUT_MS}; `0`/negative disables the idle timer.
   */
  idleTimeout?: number;
  /**
   * Optional overall deadline in ms for a streaming call (ADR-0001 §2.7): a hard
   * ceiling after which the call is cancelled with `__timeout__`. **Default off**
   * — streams may be long-lived, so a deployment opts in when it needs a cap.
   */
  deadline?: number;
}

interface WireRequest {
  input?: unknown;
  metadata?: Record<string, string>;
}

interface WireResponse {
  output?: unknown;
  error?: { _tag: string; payload?: unknown; message?: string };
}

/**
 * The streaming open envelope (ADR-0001 §2.2). One queue-group request on the
 * method subject carries the single request (`input`), context (`metadata`), the
 * two client-allocated per-call inboxes, and the initial `down` credit.
 */
interface OpenRequest {
  input?: unknown;
  metadata?: Record<string, string>;
  up: string;
  down: string;
  credit: number;
}

/**
 * A large default credit window: big enough that the host effectively never
 * pauses unless a smaller window is configured. Credit replenishment still runs
 * (a `CreditFrame` per consumed item) so the window never actually exhausts at
 * this size; configure a small `credit` to bound buffering tightly.
 */
const DEFAULT_CREDIT = 1024;

export class NatsClientTransport implements ClientTransport {
  private readonly connection: NatsConnection;
  private readonly serde: Serde<Uint8Array>;
  private readonly timeout: number;
  private readonly subjectPrefix: string;
  private readonly credit: number;
  private readonly idleTimeout: number;
  private readonly deadline: number | undefined;

  constructor(options: NatsClientTransportOptions) {
    this.connection = options.connection;
    this.serde = options.serde ?? jsonBytesSerde;
    this.timeout = options.timeout ?? 5000;
    this.subjectPrefix = options.subjectPrefix ?? 'rpc';
    this.credit = options.credit ?? DEFAULT_CREDIT;
    // Idle timeout defaults to the conservative streaming window; the overall
    // deadline is OFF unless explicitly configured (streams may be long-lived).
    this.idleTimeout = options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.deadline = options.deadline;
  }

  async invoke(request: ClientRequest): Promise<ClientResponse> {
    const subject = `${this.subjectPrefix}.${request.service}.${request.method}`;
    const wireRequest: WireRequest = {
      input: request.input,
      metadata: request.metadata,
    };
    const payload = this.serde.encode(wireRequest);

    try {
      const response = await this.connection.request(subject, payload, {
        timeout: this.timeout,
      });

      try {
        const wireResponse = this.serde.decode(response.data) as WireResponse;
        return {
          output: wireResponse.output,
          error: wireResponse.error,
        };
      } catch (err) {
        return {
          error: {
            _tag: '__serde__',
            message:
              err instanceof Error
                ? `Failed to decode response: ${err.message}`
                : 'Failed to decode response',
          },
        };
      }
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes('TIMEOUT') || err.name === 'NatsError') {
          // Check for timeout specifically
          if (err.message.includes('TIMEOUT')) {
            return {
              error: {
                _tag: '__timeout__',
                message: 'Request timed out',
              },
            };
          }
          // Check for connection closed
          if (err.message.includes('CLOSED') || err.message.includes('CONNECTION_CLOSED')) {
            return {
              error: {
                _tag: '__transport__',
                message: 'NATS connection closed',
              },
            };
          }
        }
      }

      return {
        error: {
          _tag: '__transport__',
          message: err instanceof Error ? err.message : 'Unknown transport error',
        },
      };
    }
  }

  /**
   * serverStream over NATS (ADR-0001 §2.2–2.4, happy path).
   *
   * Opens the call with ONE queue-group request on the method subject carrying an
   * {@link OpenRequest} (single request in `input`; `up`/`down` are
   * client-allocated, opaque, per-call inboxes; a large initial `credit`). The
   * selected host instance subscribes `up` and publishes output `DataFrame`s then
   * one `EndFrame` on `down`. This generator yields each decoded output until the
   * `EndFrame`, then tears down BOTH inboxes (no leaked subscriptions).
   *
   * Scope: happy path only. Mid-stream `ErrorFrame`/`CancelFrame` handling is
   * 0006/0009; the `down` subscription seam already surfaces decode failures and
   * other frames for those slices.
   */
  async *invokeServerStream(request: ClientRequest): AsyncIterable<ClientResponse> {
    const subject = `${this.subjectPrefix}.${request.service}.${request.method}`;
    const { up, down } = allocateCallInboxes();

    // Subscribe `down` BEFORE publishing the open request so no early frame is
    // missed (core NATS does not buffer for a not-yet-existing subscription).
    const downSub = subscribeFrames<Frame>(this.connection, down, (data) =>
      decodeFrame(this.serde, data)
    );

    // Detect a dropped connection mid-stream (ADR-0001 §2.6 → `__transport__`).
    // Core NATS cannot otherwise signal a parked receiver that the wire is gone;
    // `connection.closed()` resolves when the connection ends, so we tear the
    // `down` subscription down — that wakes a parked consumer with `done: true`,
    // and because no terminal frame was seen the loop falls through to the
    // early-close `__transport__` mapping below.
    let connectionClosed = false;
    void this.connection.closed().then(() => {
      connectionClosed = true;
      downSub.unsubscribe();
    });

    // Whether the call reached an explicit terminal (EndFrame/ErrorFrame/Cancel,
    // a fault, or a liveness expiry). Used by the `finally` to decide whether to
    // INITIATE a `CancelFrame` to the host (consumer abandonment) vs. let the
    // already-terminal call tear down silently.
    let terminated = false;
    // Set when a liveness timer fires so the consuming loop surfaces `__timeout__`.
    let livenessExpiry: LivenessExpiry | undefined;
    // Per-call liveness (ADR-0001 §2.7): a silent host trips the idle timer (or
    // the optional deadline), which fails the call with `__timeout__`. On expiry
    // we tear down `down` (waking a parked consumer) and mark the expiry; the loop
    // below maps it to the reserved tag. `notify()` resets the idle window on each
    // `down` frame, so a steady host never trips it.
    const liveness = startLivenessMonitor({
      idleTimeout: this.idleTimeout,
      deadline: this.deadline,
      onExpire: (reason) => {
        livenessExpiry = reason;
        terminated = true;
        downSub.unsubscribe();
      },
    });

    try {
      const open: OpenRequest = {
        input: request.input,
        metadata: request.metadata,
        up,
        down,
        credit: this.credit,
      };
      // Publish the open request on the queue-grouped method subject with `down`
      // as the reply target. The call then proceeds over the per-call inboxes;
      // this is a publish (not request/reply) because the response is a stream of
      // frames on `down`, not a single reply.
      this.connection.publish(subject, this.serde.encode(open), { reply: down });

      // Flow control on `down` (ADR-0001 §2.5): the client is the RECEIVER, so it
      // replenishes the host's `down` window by publishing a `CreditFrame` on
      // `up` as the APPLICATION consumes each DataFrame. `grantOnConsume` fires
      // the grant on the consumer's pull (not on frame arrival), so a slow
      // consumer keeps the host's in-flight output bounded to the credit window.
      const grantOne = (): void => {
        this.connection.publish(up, encodeFrame(this.serde, { t: 'c', n: 1 }));
      };
      const metered = grantOnConsume<Frame>(downSub.frames, (frame) => frame.t === 'd', grantOne);

      // Per-direction sequence tracking (ADR-0001 §2.3): `down` frames carry a
      // monotonic `seq` from 0. NATS preserves single-publisher→single-subscriber
      // order, so a gap means a lost/corrupt frame → `__transport__` (it exists to
      // DETECT loss, not to reassemble). Only `DataFrame`/`EndFrame` carry `seq`.
      let expectedSeq = 0;

      try {
        for await (const frame of metered) {
          // A frame arrived: reset the idle window (ADR-0001 §2.7). Data or
          // control alike count as liveness.
          liveness.notify();
          if (frame.t === 'd') {
            if (frame.seq !== expectedSeq) {
              // Detected `seq` gap → transport fault (ADR-0001 §2.6). Terminal:
              // stop consuming and surface the same tag vocabulary as unary.
              terminated = true;
              yield {
                error: {
                  _tag: '__transport__',
                  message: `Stream frame sequence gap on 'down': expected ${expectedSeq}, got ${frame.seq}`,
                },
              };
              return;
            }
            expectedSeq += 1;
            // DataFrame: `data` is the method's serde-encoded output. Its credit
            // was already replenished by `grantOnConsume` on this pull.
            yield { output: frame.data };
          } else if (frame.t === 'e') {
            if (frame.seq !== expectedSeq) {
              terminated = true;
              yield {
                error: {
                  _tag: '__transport__',
                  message: `Stream frame sequence gap on 'down': expected ${expectedSeq}, got ${frame.seq}`,
                },
              };
              return;
            }
            // EndFrame: graceful half-close on `down` → the call completes.
            terminated = true;
            return;
          } else if (frame.t === 'x') {
            // ErrorFrame: terminal for the whole call (ADR-0001 §2.4/§2.6). The
            // host already classified the error (a declared contract error keeps
            // its `{ _tag, payload, message }`; an undeclared throw is
            // `__unknown__`). Surface it as a `ClientResponse.error` so the client
            // throws `ContractError` (throw mode) or returns `{ ok: false, error }`
            // (result mode) — EXACTLY as unary. Already-yielded items stay
            // delivered; we stop here and tear down `down` in `finally`.
            terminated = true;
            yield { error: frame.error };
            return;
          } else if (frame.t === 'a') {
            // CancelFrame from the host aborts the call. Full cancel semantics are
            // issue 0009; here it is a terminal that stops the stream cleanly so
            // the client never hangs on an aborted call.
            terminated = true;
            return;
          }
          // CreditFrame on `down` is host→client flow control for `up` DataFrames
          // (clientStream/duplex, issues 0007/0008); ignored for serverStream.
        }
      } catch (err) {
        terminated = true;
        if (err instanceof FrameDecodeError) {
          // A frame failed to decode (the `down` subscription surfaces the
          // serde's throw on the consuming pull) → `__serde__`, the same tag
          // unary uses for wire corruption (ADR-0001 §2.6).
          yield { error: { _tag: '__serde__', message: err.message } };
          return;
        }
        // Any other fault on the `down` subscription (a connection/permission
        // error surfaced by the NATS callback) is a transport fault.
        yield {
          error: {
            _tag: '__transport__',
            message: err instanceof Error ? err.message : 'Stream transport error',
          },
        };
        return;
      }

      // `down` was torn down without an in-band terminal frame. This is EITHER a
      // liveness expiry (idle/deadline → `__timeout__`, ADR-0001 §2.7) OR the
      // connection closing early mid-stream (→ `__transport__`, §2.6).
      if (livenessExpiry !== undefined) {
        yield {
          error: {
            _tag: TIMEOUT_TAG,
            message:
              livenessExpiry === 'idle'
                ? `Stream idle for ${this.idleTimeout}ms (no frame on 'down')`
                : `Stream exceeded overall deadline of ${this.deadline}ms`,
          },
        };
      } else if (!terminated) {
        yield {
          error: {
            _tag: '__transport__',
            message: connectionClosed
              ? 'NATS connection closed mid-stream'
              : "Stream 'down' channel closed before a terminal frame",
          },
        };
      }
    } finally {
      // Stop the liveness monitor so a finished call never fires a late timeout.
      liveness.stop();
      // Cancel-initiation (ADR-0001 §2.7): if the call did NOT reach an in-band
      // terminal — the consumer abandoned the iterator early (`break`/`return()`),
      // or a liveness timer fired — tell the host to stop and tear down by
      // publishing a `CancelFrame` on `up`. A naturally-terminated call (host
      // EndFrame/ErrorFrame/Cancel) needs no cancel. Publish is best-effort; a
      // closed connection simply drops it.
      if (!terminated) {
        try {
          this.connection.publish(up, encodeFrame(this.serde, { t: 'a' }));
        } catch {
          // Connection gone; the host tears down via its own liveness/close path.
        }
      }
      // Tear down the client-subscribed `down` inbox. (`up` is host-subscribed;
      // host-side teardown is the host transport's job.) Closing `down` is the
      // client's leak guarantee.
      downSub.unsubscribe();
    }
  }

  /**
   * clientStream over NATS (ADR-0001 §2.2-2.6).
   *
   * The mirror of {@link invokeServerStream}, metering the OTHER direction. Opens
   * the call with ONE queue-group request carrying an {@link OpenRequest} (no
   * `input` — clientStream inputs ride `up` as frames). The client is the SENDER
   * on `up`: it streams each input as a `DataFrame`, then sends exactly one
   * `EndFrame` (half-close). The host is the receiver and replies on `down` with
   * its single output `DataFrame` followed by an `EndFrame`; the `down` `EndFrame`
   * is call completion (ADR-0001 §2.4). This resolves to one {@link ClientResponse}
   * (the aggregated output, or a terminal error), exactly as unary.
   *
   * Backpressure meters `up` (ADR-0001 §2.5): the client paces its input against a
   * {@link CreditController} the HOST grants — the host's first `CreditFrame` on
   * `down`, replenished as it consumes inputs. Reuses the same credit helpers as
   * serverStream (direction-blind by design); here the controller rides `up`.
   */
  async invokeClientStream(
    request: ClientRequest,
    inputStream: AsyncIterable<unknown>
  ): Promise<ClientResponse> {
    const subject = `${this.subjectPrefix}.${request.service}.${request.method}`;
    const { up, down } = allocateCallInboxes();

    // Subscribe `down` BEFORE publishing the open request so no early frame (the
    // host's initial `CreditFrame`, output, or terminal) is missed.
    const downSub = subscribeFrames<Frame>(this.connection, down, (data) =>
      decodeFrame(this.serde, data)
    );

    // Flow control on `up` (ADR-0001 §2.5): the client is the SENDER, so it paces
    // its input frames against a credit window the HOST grants. Initial credit is
    // 0 until the host's first `CreditFrame` on `down` (the host grants the `up`
    // window as it begins consuming). Mirrors the host's `down` controller.
    const upCredit = new CreditController(0);

    // The host subscribes `up` only AFTER it receives the open request, so the
    // client must not publish ANY `up` frame (input or the EndFrame half-close)
    // before the host is listening — core NATS does not buffer for a not-yet-bound
    // subscription. The host's first `CreditFrame` on `down` doubles as the
    // "ready on `up`" signal (it grants the initial window). This promise resolves
    // on that first grant so the pump (including an EMPTY stream's immediate
    // EndFrame) waits for the host to be ready. It is also resolved on terminal
    // teardown so the pump never hangs on a call that ends before any grant.
    let resolveHostReady!: () => void;
    const hostReady = new Promise<void>((resolve) => {
      resolveHostReady = resolve;
    });

    // Detect a dropped connection mid-call (ADR-0001 §2.6 → `__transport__`): tear
    // the `down` subscription down so a parked consumer wakes, and release any
    // producer parked at credit 0 so the input loop does not hang.
    let connectionClosed = false;
    void this.connection.closed().then(() => {
      connectionClosed = true;
      resolveHostReady();
      upCredit.cancel();
      downSub.unsubscribe();
    });

    // Publish the open request on the queue-grouped method subject. No `input`
    // (clientStream inputs ride `up` as frames). `credit` is the client's grant to
    // the host on `down`; the host sends only one output frame there, so the
    // default large window never throttles it.
    const open: OpenRequest = {
      metadata: request.metadata,
      up,
      down,
      credit: this.credit,
    };
    this.connection.publish(subject, this.serde.encode(open), { reply: down });

    const upSeq = new SeqCounter();
    // Whether the call reached its terminal `down` frame (EndFrame/ErrorFrame). If
    // the input pump is still running when a terminal arrives, it must stop.
    let terminated = false;
    // Whether the host drove the terminal (its output, ErrorFrame, or CancelFrame
    // on `down`). When true the host is already done, so no cancel is initiated.
    let hostTerminated = false;
    // Set when a liveness timer fires so the result surfaces `__timeout__`.
    let livenessExpiry: LivenessExpiry | undefined;
    // Per-call liveness (ADR-0001 §2.7): a silent host trips the idle timer (or the
    // optional deadline). On expiry tear down `down` (waking the waiter), release
    // the up pump, and mark the expiry; the `down` loop maps it to `__timeout__`.
    const liveness = startLivenessMonitor({
      idleTimeout: this.idleTimeout,
      deadline: this.deadline,
      onExpire: (reason) => {
        livenessExpiry = reason;
        terminated = true;
        resolveHostReady();
        upCredit.cancel();
        downSub.unsubscribe();
      },
    });

    // Pump the application input stream onto `up` as DataFrames, gated by credit,
    // then half-close with exactly one EndFrame. Runs concurrently with consuming
    // `down`. A throw from the application iterable, or a terminal `down` frame,
    // stops it early (no EndFrame in that case — the call is already ending).
    const pumpInput = (async (): Promise<void> => {
      try {
        // Wait for the host to be listening on `up` (its first `CreditFrame` on
        // `down`) before publishing anything — this also gates an empty stream's
        // immediate EndFrame so the host never misses the half-close.
        await hostReady;
        if (terminated) {
          return;
        }
        for await (const item of inputStream) {
          if (terminated) {
            return;
          }
          // Reserve one `up` credit before publishing; parks at credit 0 until the
          // host's next `CreditFrame`, bounding in-flight input to the window.
          await upCredit.acquire();
          if (terminated) {
            return;
          }
          this.connection.publish(
            up,
            encodeFrame(this.serde, { t: 'd', seq: upSeq.take(), data: item })
          );
        }
        if (!terminated) {
          // Graceful half-close on `up`: exactly one terminal EndFrame.
          this.connection.publish(up, encodeFrame(this.serde, { t: 'e', seq: upSeq.take() }));
        }
      } catch {
        // The application input iterable threw. We have nothing to aggregate; the
        // call ends via the `down` consumer (or its early-close mapping). Stop
        // pumping. (Surfacing a producer-side throw as a tagged error is a client
        // concern; here we just avoid hanging.)
      }
    })();

    try {
      for await (const frame of downSub.frames) {
        // A frame arrived: reset the idle window (ADR-0001 §2.7).
        liveness.notify();
        if (frame.t === 'c') {
          // The host grants `up` credit as it consumes inputs (or up front). The
          // first grant is also the host's "ready on `up`" signal — release the
          // pump so it may begin (including an empty stream's EndFrame). This wakes
          // the client paused at credit 0.
          resolveHostReady();
          upCredit.grant(frame.n);
        } else if (frame.t === 'd') {
          // The host's single output DataFrame. We do NOT complete here — the call
          // completes on the following `down` EndFrame (ADR-0001 §2.4). Capture it.
          terminated = true;
          hostTerminated = true;
          upCredit.cancel();
          // Drain to the terminal EndFrame so the host's half-close is observed,
          // but the output is already in hand; return it.
          return { output: frame.data };
        } else if (frame.t === 'x') {
          // Terminal ErrorFrame: the host classified the error (declared contract
          // error keeps its `{ _tag, payload, message }`; an undeclared throw is
          // `__unknown__`). Surface it as unary does.
          terminated = true;
          hostTerminated = true;
          upCredit.cancel();
          return { error: frame.error };
        } else if (frame.t === 'a') {
          // CancelFrame from the host aborts the call (full cancel semantics are
          // issue 0009); terminal so the client never hangs.
          terminated = true;
          hostTerminated = true;
          upCredit.cancel();
          return {
            error: { _tag: '__transport__', message: 'Stream cancelled by host' },
          };
        }
        // A bare `EndFrame` with no preceding output DataFrame is an early
        // half-close on `down` without a result → transport fault (handled below).
      }
      // `down` was torn down without a result/terminal frame. EITHER a liveness
      // expiry (idle/deadline → `__timeout__`, ADR-0001 §2.7) OR the connection
      // closing early mid-call (→ `__transport__`, §2.6).
      terminated = true;
      upCredit.cancel();
      if (livenessExpiry !== undefined) {
        return {
          error: {
            _tag: TIMEOUT_TAG,
            message:
              livenessExpiry === 'idle'
                ? `Stream idle for ${this.idleTimeout}ms (no frame on 'down')`
                : `Stream exceeded overall deadline of ${this.deadline}ms`,
          },
        };
      }
      return {
        error: {
          _tag: '__transport__',
          message: connectionClosed
            ? 'NATS connection closed mid-stream'
            : "Stream 'down' channel closed before a terminal frame",
        },
      };
    } catch (err) {
      terminated = true;
      upCredit.cancel();
      if (err instanceof FrameDecodeError) {
        return { error: { _tag: '__serde__', message: err.message } };
      }
      return {
        error: {
          _tag: '__transport__',
          message: err instanceof Error ? err.message : 'Stream transport error',
        },
      };
    } finally {
      // Stop the liveness monitor so a finished call never fires a late timeout.
      liveness.stop();
      // Stop the input pump and tear down the client-subscribed `down` inbox.
      // (`up` is host-subscribed; host-side teardown is the host transport's job.)
      // Release a pump still waiting on the host-ready gate (the call may end
      // before any credit grant, e.g. a host throw) so it never hangs.
      terminated = true;
      resolveHostReady();
      upCredit.cancel();
      // Cancel-initiation (ADR-0001 §2.7): if the host did NOT drive the terminal
      // (a liveness timer fired, or `down` closed early), publish a `CancelFrame`
      // on `up` so the host stops consuming inputs and tears down its `up` inbox.
      // A host-driven terminal needs none. Best-effort; a closed connection drops it.
      if (!hostTerminated) {
        try {
          this.connection.publish(up, encodeFrame(this.serde, { t: 'a' }));
        } catch {
          // Connection gone; the host tears down via its own liveness/close path.
        }
      }
      downSub.unsubscribe();
      await pumpInput;
    }
  }

  /**
   * duplex over NATS (ADR-0001 §2.2/§2.4).
   *
   * Both directions stream INDEPENDENTLY and CONCURRENTLY — this is the union of
   * the two halves already proven by serverStream and clientStream, metering each
   * direction with its OWN credit pair:
   *
   * - `up` (client → host, client is SENDER): the client pumps its input stream as
   *   `DataFrame`s, gated by an {@link CreditController} the HOST grants (the host's
   *   `CreditFrame`s on `down`), then half-closes with exactly one `EndFrame`. Reuses
   *   the clientStream pump verbatim, including the 0007 HOST-READY handshake — the
   *   client publishes nothing on `up` (not even an empty stream's `EndFrame`) until
   *   the host's first `CreditFrame` on `down` confirms it is subscribed on `up`.
   * - `down` (host → client, client is RECEIVER): the client yields each decoded
   *   output `DataFrame`, replenishing the host's `down` window with a `CreditFrame`
   *   on `up` per consumed item (`grantOnConsume`). The `down` `EndFrame` is the
   *   host's half-close.
   *
   * The yielded `AsyncIterable` completes when `down` half-closes (the client has no
   * more outputs to surface); the `up` pump finishes independently (its own
   * `EndFrame`). An `ErrorFrame`/`CancelFrame` on `down` is terminal for the whole
   * call and tears down BOTH directions. Both inboxes unsubscribe on any exit.
   */
  async *invokeDuplex(
    request: ClientRequest,
    inputStream: AsyncIterable<unknown>
  ): AsyncIterable<ClientResponse> {
    const subject = `${this.subjectPrefix}.${request.service}.${request.method}`;
    const { up, down } = allocateCallInboxes();

    // Subscribe `down` BEFORE publishing the open request so no early frame (the
    // host's initial `CreditFrame`, an output, or a terminal) is missed.
    const downSub = subscribeFrames<Frame>(this.connection, down, (data) =>
      decodeFrame(this.serde, data)
    );

    // `up` flow control (ADR-0001 §2.5): the client is the SENDER on `up`, pacing
    // its input against a window the HOST grants. Starts at 0 until the host's first
    // `CreditFrame` on `down`. Mirrors clientStream.
    const upCredit = new CreditController(0);

    // 0007 host-ready gate (REUSED for duplex's `up` half): the host subscribes
    // `up` only AFTER it receives the open request, so the client must not publish
    // ANY `up` frame (input or the half-close `EndFrame`) before the host is
    // listening. The host's first `CreditFrame` on `down` doubles as the "ready on
    // `up`" signal. Resolved also on terminal teardown so the pump never hangs.
    let resolveHostReady!: () => void;
    const hostReady = new Promise<void>((resolve) => {
      resolveHostReady = resolve;
    });

    // Detect a dropped connection mid-call (ADR-0001 §2.6 → `__transport__`): tear
    // `down` down (waking a parked consumer), release the up-ready gate, and cancel
    // the up window so the input pump does not hang.
    let connectionClosed = false;
    void this.connection.closed().then(() => {
      connectionClosed = true;
      resolveHostReady();
      upCredit.cancel();
      downSub.unsubscribe();
    });

    // Whether the call reached a terminal (down EndFrame/ErrorFrame/Cancel, a
    // fault, or teardown). Stops the input pump and gates the `down` loop.
    let terminated = false;
    // Set when a liveness timer fires so the `down` loop surfaces `__timeout__`.
    let livenessExpiry: LivenessExpiry | undefined;
    // Per-call liveness (ADR-0001 §2.7): a silent host trips the idle timer (or
    // the optional deadline). On expiry we tear down `down` (waking the consumer),
    // release the up pump, and mark the expiry; the loop maps it to `__timeout__`.
    // `notify()` resets the idle window on each `down` frame.
    const liveness = startLivenessMonitor({
      idleTimeout: this.idleTimeout,
      deadline: this.deadline,
      onExpire: (reason) => {
        livenessExpiry = reason;
        terminated = true;
        resolveHostReady();
        upCredit.cancel();
        downSub.unsubscribe();
      },
    });

    // Publish the open request on the queue-grouped method subject. No `input`
    // (duplex inputs ride `up` as frames). `credit` is the client's grant to the
    // host on `down` (the host's output window).
    const open: OpenRequest = {
      metadata: request.metadata,
      up,
      down,
      credit: this.credit,
    };
    this.connection.publish(subject, this.serde.encode(open), { reply: down });

    const upSeq = new SeqCounter();

    // The `up` half: pump the application input stream onto `up` as DataFrames,
    // gated by the host-granted credit, then half-close with exactly one EndFrame.
    // Runs CONCURRENTLY with consuming `down`. A throw from the application iterable
    // or a terminal on `down` stops it early (no EndFrame then — the call is ending).
    const pumpInput = (async (): Promise<void> => {
      try {
        await hostReady;
        if (terminated) {
          return;
        }
        for await (const item of inputStream) {
          if (terminated) {
            return;
          }
          await upCredit.acquire();
          if (terminated) {
            return;
          }
          this.connection.publish(
            up,
            encodeFrame(this.serde, { t: 'd', seq: upSeq.take(), data: item })
          );
        }
        if (!terminated) {
          // Graceful half-close on `up`: exactly one terminal EndFrame.
          this.connection.publish(up, encodeFrame(this.serde, { t: 'e', seq: upSeq.take() }));
        }
      } catch {
        // The application input iterable threw. The call ends via the `down`
        // consumer; stop pumping so it never hangs.
      }
    })();

    // The `down` half: replenish the host's `down` window on application
    // consumption (a `CreditFrame` on `up` per consumed DataFrame). `grantOnConsume`
    // fires on the consumer's pull (not on frame arrival), so a slow consumer keeps
    // the host's in-flight output bounded to the credit window — independent of the
    // `up` window above.
    const grantDownOne = (): void => {
      this.connection.publish(up, encodeFrame(this.serde, { t: 'c', n: 1 }));
    };
    const meteredDown = grantOnConsume<Frame>(
      downSub.frames,
      (frame) => frame.t === 'd',
      grantDownOne
    );

    // Per-direction sequence tracking on `down` (ADR-0001 §2.3): a gap is a lost
    // or corrupt frame → `__transport__`.
    let expectedSeq = 0;
    // Whether `down` reached an explicit terminator; if it ends WITHOUT one the
    // connection dropped early → `__transport__`.
    let downTerminated = false;

    try {
      for await (const frame of meteredDown) {
        // A frame arrived: reset the idle window (ADR-0001 §2.7).
        liveness.notify();
        if (frame.t === 'c') {
          // The host grants `up` credit as it consumes inputs (or up front). The
          // first grant is also the host's "ready on `up`" signal — release the
          // pump so it may begin (including an empty stream's EndFrame).
          resolveHostReady();
          upCredit.grant(frame.n);
        } else if (frame.t === 'd') {
          if (frame.seq !== expectedSeq) {
            terminated = true;
            downTerminated = true;
            yield {
              error: {
                _tag: '__transport__',
                message: `Stream frame sequence gap on 'down': expected ${expectedSeq}, got ${frame.seq}`,
              },
            };
            return;
          }
          expectedSeq += 1;
          // A host output DataFrame: its credit was already replenished by
          // `grantOnConsume` on this pull. Surface it to the application.
          yield { output: frame.data };
        } else if (frame.t === 'e') {
          if (frame.seq !== expectedSeq) {
            terminated = true;
            downTerminated = true;
            yield {
              error: {
                _tag: '__transport__',
                message: `Stream frame sequence gap on 'down': expected ${expectedSeq}, got ${frame.seq}`,
              },
            };
            return;
          }
          // `down` half-close: the host has no more outputs. The call's observable
          // result is the stream of outputs, so the yielded iterable completes here.
          // The `up` pump finishes independently with its own EndFrame.
          downTerminated = true;
          return;
        } else if (frame.t === 'x') {
          // Terminal ErrorFrame: the host classified the error (declared contract
          // error keeps its `{ _tag, payload, message }`; an undeclared throw is
          // `__unknown__`). Terminal for the WHOLE call — tear down both directions.
          // Already-yielded items stay delivered.
          terminated = true;
          downTerminated = true;
          yield { error: frame.error };
          return;
        } else if (frame.t === 'a') {
          // CancelFrame from the host aborts the whole call (both directions).
          terminated = true;
          downTerminated = true;
          return;
        }
      }
      // `down` was torn down with no in-band terminator. EITHER a liveness expiry
      // (idle/deadline → `__timeout__`, ADR-0001 §2.7) OR the connection closing
      // early mid-call (→ `__transport__`, §2.6).
      if (!downTerminated) {
        terminated = true;
        if (livenessExpiry !== undefined) {
          yield {
            error: {
              _tag: TIMEOUT_TAG,
              message:
                livenessExpiry === 'idle'
                  ? `Stream idle for ${this.idleTimeout}ms (no frame on 'down')`
                  : `Stream exceeded overall deadline of ${this.deadline}ms`,
            },
          };
        } else {
          yield {
            error: {
              _tag: '__transport__',
              message: connectionClosed
                ? 'NATS connection closed mid-stream'
                : "Stream 'down' channel closed before a terminal frame",
            },
          };
        }
      }
    } catch (err) {
      terminated = true;
      downTerminated = true;
      if (err instanceof FrameDecodeError) {
        yield { error: { _tag: '__serde__', message: err.message } };
        return;
      }
      yield {
        error: {
          _tag: '__transport__',
          message: err instanceof Error ? err.message : 'Stream transport error',
        },
      };
      return;
    } finally {
      // Stop the liveness monitor so a finished call never fires a late timeout.
      liveness.stop();
      terminated = true;
      resolveHostReady();
      upCredit.cancel();
      // Cancel-initiation (ADR-0001 §2.7): publish a `CancelFrame` on `up` so the
      // host stops BOTH directions and tears down WHEN the call did not end with
      // an in-band `down` terminal from the host — i.e. the consumer abandoned the
      // iterable (`break`/`return()`) before `down` half-closed, or a liveness
      // timer fired. A host-driven terminal (`down` EndFrame / ErrorFrame / host
      // CancelFrame, all of which set `downTerminated`) needs no cancel: the host
      // is already done. Best-effort; a closed connection drops it.
      if (!downTerminated || livenessExpiry !== undefined) {
        try {
          this.connection.publish(up, encodeFrame(this.serde, { t: 'a' }));
        } catch {
          // Connection gone; the host tears down via its own liveness/close path.
        }
      }
      downSub.unsubscribe();
      await pumpInput;
    }
  }
}
