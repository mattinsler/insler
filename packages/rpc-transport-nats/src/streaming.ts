import type { NatsConnection, Subscription } from '@nats-io/transport-node';
import { createInbox } from '@nats-io/transport-node';

/**
 * Per-call subscription lifecycle helpers for the RPC streaming plane.
 *
 * A streaming call is established by one queue-group request on the method
 * subject carrying two client-allocated, opaque, per-call inboxes (`up` for
 * client→host frames, `down` for host→client frames; ADR-0001 §2.2/§2.8). This
 * module owns the lifetime of those subscriptions so neither inbox leaks on
 * normal completion — the central guarantee issue 0004 must hold (and the later
 * slices inherit for errors/cancel/timeout).
 *
 * It is intentionally agnostic to the frame *semantics* (which frame ends the
 * call, credit accounting, error mapping): those live in the client/host stream
 * drivers and differ per kind. This module provides only the mechanics every
 * kind shares — inbox allocation, a push-based frame subscription with a bounded
 * async queue, and idempotent teardown of both inboxes.
 */

/**
 * Allocate the two opaque, per-call inboxes for a streaming call using the NATS
 * client's standard new-inbox generation (`createInbox`). They are unguessable
 * and unique per call (ADR-0001 §2.8).
 */
export function allocateCallInboxes(): { up: string; down: string } {
  return { up: createInbox(), down: createInbox() };
}

/**
 * A single subscription paired with idempotent teardown. The host pins a call to
 * itself by subscribing `up` with NO queue group; the client subscribes `down`.
 * Both are wrapped here so callers tear down with one idempotent `unsubscribe()`.
 */
export interface CallSubscription<T> {
  /** Async iterable of decoded frames delivered on the inbox, in arrival order. */
  frames: AsyncIterable<T>;
  /** Idempotently unsubscribe the inbox. Safe to call more than once. */
  unsubscribe(): void;
}

/**
 * Subscribe an inbox and decode each raw message into a `T` via `decode`,
 * exposing them as a back-pressure-friendly async iterable.
 *
 * Decode errors are not swallowed: `decode` may throw, and the throw surfaces on
 * the consuming `for await` so the caller's per-call error mapping can turn it
 * into the reserved `__serde__` tag (mid-stream parity with unary — exercised in
 * a later slice; the seam is here now).
 *
 * Teardown: `unsubscribe()` is idempotent and also wakes a parked consumer so the
 * async iterable completes (`done: true`) rather than hanging — this is what lets
 * a caller guarantee "no leaked subscriptions" on completion.
 */
export function subscribeFrames<T>(
  connection: NatsConnection,
  subject: string,
  decode: (data: Uint8Array) => T
): CallSubscription<T> {
  // Bounded hand-off between the NATS callback (producer) and the async iterator
  // (consumer). Values and errors share ONE ordered queue and ONE parked-waiter
  // slot so a value and a later error can never resolve/reject the same pending
  // `next()` out of order: a parked consumer is woken by whichever event (value,
  // error, or close) arrives first, FIFO.
  const queue: Array<{ ok: true; value: T } | { ok: false; error: unknown }> = [];
  // The single parked consumer (at most one `next()` is outstanding at a time for
  // a single-iterator stream). Both arms are held together so delivering a value
  // and delivering an error are mutually exclusive for a given pull.
  let pending: { resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void } | null =
    null;
  let closed = false;

  const subscription: Subscription = connection.subscribe(subject, {
    callback: (err, msg) => {
      if (closed) {
        return;
      }
      if (err) {
        // A subscription-level error (e.g. permission/closed) surfaces to the
        // consumer; the caller maps it to a transport-level tag.
        deliverError(err);
        return;
      }
      let decoded: T;
      try {
        decoded = decode(msg.data);
      } catch (decodeErr) {
        // A decode failure surfaces on the consuming pull so the caller maps it
        // to `__serde__` (mid-stream parity with unary).
        deliverError(decodeErr);
        return;
      }
      deliverValue(decoded);
    },
  });

  function deliverValue(value: T): void {
    if (pending) {
      const { resolve } = pending;
      pending = null;
      resolve({ done: false, value });
    } else {
      queue.push({ ok: true, value });
    }
  }

  function deliverError(error: unknown): void {
    if (pending) {
      const { reject } = pending;
      pending = null;
      reject(error);
    } else {
      queue.push({ ok: false, error });
    }
  }

  function unsubscribe(): void {
    if (closed) {
      return;
    }
    closed = true;
    subscription.unsubscribe();
    // Wake a parked consumer so the iterable completes instead of hanging.
    if (pending) {
      const { resolve } = pending;
      pending = null;
      resolve({ done: true, value: undefined });
    }
  }

  const frames: AsyncIterable<T> = {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          const head = queue.shift();
          if (head) {
            if (head.ok) {
              return Promise.resolve({ done: false, value: head.value });
            }
            return Promise.reject(head.error);
          }
          if (closed) {
            return Promise.resolve({ done: true, value: undefined });
          }
          return new Promise<IteratorResult<T>>((resolve, reject) => {
            pending = { resolve, reject };
          });
        },
      };
    },
  };

  return { frames, unsubscribe };
}
