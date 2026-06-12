import type { Serde } from '@insler/serde';

/**
 * RPC-plane streaming frame envelope for `@insler/rpc-transport-nats`.
 *
 * Every message on a streaming call's `up`/`down` inbox is a serde-encoded
 * {@link Frame}. The envelope is defined here, independently of any concrete
 * encoding — the same injected `Serde<Uint8Array>` that carries unary payloads
 * encodes frames, so a CBOR/msgpack/avro serde streams without special-casing
 * (ADR-0001 §2.3, PRD user story 38).
 *
 * Field names are deliberately short (`t`, `seq`, `data`, `n`, …) because they
 * ride *every* frame. The discriminant is `t`.
 *
 * Scope (issue 0004 — serverStream happy path): only {@link DataFrame} and
 * {@link EndFrame} are exercised on the wire. {@link ErrorFrame},
 * {@link CreditFrame}, and {@link CancelFrame} are defined here as the shared
 * vocabulary so the later streaming slices extend cleanly:
 *
 * - `0005` (flow control) — {@link CreditFrame}
 * - `0006` (mid-stream errors) — {@link ErrorFrame}
 * - `0007`/`0008` (clientStream/duplex) — `up` `DataFrame`/`EndFrame`
 * - `0009` (liveness/cancel) — {@link CancelFrame}
 *
 * `seq` is a per-direction monotonic counter starting at 0 (ADR-0001 §2.3). It
 * exists to *detect* loss/corruption (→ `__transport__`), not to reassemble:
 * core NATS preserves publish order from a single publisher to a single
 * subscriber, so reordering is not expected. Issue 0004 publishes a correct
 * sequence; gap *detection* is layered on in a later slice.
 */

/** Frame discriminants. `'d'` data, `'e'` end, `'x'` error, `'c'` credit, `'a'` cancel (abort). */
export type FrameTag = 'd' | 'e' | 'x' | 'c' | 'a';

/** A serialized contract error as it rides an {@link ErrorFrame} (parity with unary). */
export interface FrameError {
  _tag: string;
  payload?: unknown;
  message?: string;
}

/** A unit of stream payload: `data` is the method's serde-encoded input|output. */
export interface DataFrame {
  t: 'd';
  /** Per-direction monotonic sequence, from 0. */
  seq: number;
  /** The method's serde-encoded input or output (same encoder as the unary envelope). */
  data: unknown;
}

/** Half-close sentinel: this direction has no more {@link DataFrame}s. */
export interface EndFrame {
  t: 'e';
  /** Per-direction monotonic sequence, from 0. */
  seq: number;
}

/** Terminal for the whole call: a declared contract error or reserved `__*__` tag. */
export interface ErrorFrame {
  t: 'x';
  error: FrameError;
}

/** Flow-control: grant the peer `n` more {@link DataFrame}s on this direction. */
export interface CreditFrame {
  t: 'c';
  n: number;
}

/** Abort the whole call in both directions. */
export interface CancelFrame {
  t: 'a';
  reason?: string;
}

/** The streaming frame envelope. One discriminant `t`. */
export type Frame = DataFrame | EndFrame | ErrorFrame | CreditFrame | CancelFrame;

/**
 * Encode a {@link Frame} to wire bytes through the injected serde. The serde is
 * the single seam between protocol envelope and wire format — frames go through
 * the *same* encoder as the unary `WireRequest`/`WireResponse`.
 */
export function encodeFrame(serde: Serde<Uint8Array>, frame: Frame): Uint8Array {
  return serde.encode(frame);
}

/**
 * A frame whose wire bytes failed to decode through the serde. The per-call
 * error mapping maps this to the reserved `__serde__` tag (mid-stream parity with
 * unary — the same tag unary uses for wire corruption). It is a distinct class so
 * a decode fault is told apart from a subscription/connection fault (which maps
 * to `__transport__`): both surface on the same consuming `for await`, so the tag
 * cannot be inferred from the throw site alone.
 */
export class FrameDecodeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FrameDecodeError';
  }
}

/**
 * Decode wire bytes back to a {@link Frame}. A serde decode failure is rethrown
 * as a {@link FrameDecodeError} so the caller's per-call mapping can attribute it
 * to `__serde__` (vs a `__transport__` subscription fault). Mid-stream parity
 * with unary, ADR-0001 §2.6.
 */
export function decodeFrame(serde: Serde<Uint8Array>, wire: Uint8Array): Frame {
  try {
    return serde.decode(wire) as Frame;
  } catch (err) {
    throw new FrameDecodeError(
      err instanceof Error
        ? `Failed to decode stream frame: ${err.message}`
        : 'Failed to decode stream frame',
      { cause: err }
    );
  }
}

/**
 * A monotonic per-direction sequence allocator, starting at 0. Shared by both
 * the host (publishing on `down`) and, in later slices, the client (publishing
 * on `up`). Keeping it here means every producer numbers frames identically.
 */
export class SeqCounter {
  private next = 0;

  /** Take the next sequence number (0, 1, 2, …). */
  take(): number {
    return this.next++;
  }
}
