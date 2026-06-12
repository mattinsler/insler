/**
 * Credit-based flow control for the RPC streaming plane (ADR-0001 §2.5).
 *
 * The "no unbounded buffering" guarantee: a sender may have at most `credit`
 * un-acknowledged {@link DataFrame}s in flight per direction. As the RECEIVER
 * consumes a `DataFrame` from the application `AsyncIterable`, it grants the
 * sender `n` more credits via a {@link CreditFrame}. When credit reaches 0 the
 * sender pauses; it resumes on the next `CreditFrame`. Replenishment is driven
 * by application consumption, not by frame arrival.
 *
 * The machinery here is deliberately **direction-agnostic and symmetric** so the
 * later streaming slices reuse it without change:
 *
 * - `0005` (this slice) meters `down` (host is the sender, client the receiver).
 * - `0007` (clientStream) meters `up` (client is the sender, host the receiver) —
 *   reuses {@link CreditController} on the client and {@link grantOnConsume} on
 *   the host.
 * - `0008` (duplex) meters BOTH directions — one {@link CreditController} +
 *   {@link grantOnConsume} pair per direction.
 *
 * Neither helper knows which physical inbox (`up`/`down`) it rides; the caller
 * wires a `CreditController` to the side that PUBLISHES DataFrames and
 * {@link grantOnConsume} to the side that CONSUMES them.
 */

/**
 * The sender's view of a credit window. The sender calls {@link acquire} before
 * publishing each `DataFrame`; if the window is exhausted (credit 0) the returned
 * promise parks until the peer's next {@link grant}. {@link grant} is called with
 * the `n` from each inbound {@link CreditFrame}.
 *
 * One controller per metered direction. It is single-producer (the publishing
 * side awaits {@link acquire} sequentially) but {@link grant} may be invoked from
 * the inbound-frame callback concurrently — the two coordinate through the parked
 * waiter list.
 */
export class CreditController {
  private credit: number;
  /** Resolvers for senders parked at credit 0, woken FIFO as credit is granted. */
  private readonly waiters: Array<() => void> = [];
  private cancelled = false;

  /**
   * @param initialCredit the window the receiver grants up front. For `down` this
   *   is `OpenRequest.credit`; for `up` it starts at 0 until the host's first
   *   `CreditFrame` grants the initial window (ADR-0001 §2.5).
   */
  constructor(initialCredit: number) {
    this.credit = initialCredit;
  }

  /** Current available credit (un-consumed window). Primarily for assertions. */
  get available(): number {
    return this.credit;
  }

  /**
   * Reserve one credit before publishing a `DataFrame`. Resolves immediately when
   * credit is available (decrementing the window); otherwise parks until a
   * {@link grant} (or {@link cancel}) wakes it. At most `credit` DataFrames are
   * ever in flight because every publish is gated by this call.
   */
  acquire(): Promise<void> {
    if (this.cancelled) {
      return Promise.resolve();
    }
    if (this.credit > 0) {
      this.credit -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /**
   * Grant `n` more credits (from an inbound {@link CreditFrame}). Wakes parked
   * senders FIFO, each consuming one credit as it resumes; any surplus stays in
   * the window for subsequent {@link acquire} calls.
   */
  grant(n: number): void {
    if (this.cancelled || n <= 0) {
      return;
    }
    this.credit += n;
    while (this.credit > 0 && this.waiters.length > 0) {
      const wake = this.waiters.shift()!;
      this.credit -= 1;
      wake();
    }
  }

  /**
   * Release any parked sender unconditionally (on terminal frame / teardown /
   * timeout) so a paused producer does not hang forever. After cancellation
   * {@link acquire} resolves immediately — the caller is expected to stop
   * publishing because the call is ending.
   */
  cancel(): void {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    for (const wake of this.waiters.splice(0)) {
      wake();
    }
  }
}

/**
 * Wrap a receiver's frame `AsyncIterable` so that **as each `DataFrame` is pulled
 * by the application**, `grant(1)` runs — replenishing exactly one credit on the
 * sender's window per consumed item. This is the receiver half of the credit
 * loop, and the timing is the point: the grant fires on the consumer's `next()`
 * pull (application consumption), NOT when the frame arrives off the wire. That
 * is what keeps the in-flight window bounded under a slow consumer.
 *
 * `grant` is invoked once per item, just before the item is handed to the
 * consumer. Non-`DataFrame`s (end/error/credit/cancel) pass through untouched and
 * never grant credit — only DataFrames consume the window. The caller supplies a
 * `isData` predicate plus the `grant` side effect (publishing a `CreditFrame`).
 */
export async function* grantOnConsume<T>(
  source: AsyncIterable<T>,
  isData: (frame: T) => boolean,
  grant: () => void
): AsyncIterable<T> {
  for await (const frame of source) {
    if (isData(frame)) {
      // Application consumption replenishes the window: the consumer has just
      // pulled this DataFrame, so the sender may send one more.
      grant();
    }
    yield frame;
  }
}
