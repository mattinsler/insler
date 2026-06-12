/**
 * Per-call liveness for the RPC streaming plane (ADR-0001 §2.7).
 *
 * Core NATS cannot tell a parked receiver that its peer has silently died — a
 * subscription on an inbox simply never delivers another message. Two timers
 * guard against that, both scoped to a single streaming call:
 *
 * - **Idle (stall) timeout** — if NO frame (data *or* control) arrives within the
 *   configured window, the waiting side fails the call with `__timeout__` and
 *   tears down. The window resets on every inbound frame, so a steady (even slow)
 *   peer never trips it; only genuine silence does. This is the primary guard
 *   against a half-dead call hanging forever.
 * - **Overall deadline** — an OPTIONAL hard ceiling on the whole call. Default OFF
 *   for streams, since a streaming call may legitimately be long-lived; a
 *   deployment that needs a cap opts in. On expiry the call is cancelled with
 *   `__timeout__`.
 *
 * Both surface the SAME reserved tag (`__timeout__`) so the client sees the same
 * vocabulary unary already uses for a dead request. The helper here is the timer
 * mechanism only; the caller wires the `onExpire` callback to its own teardown
 * (unsubscribe both inboxes, send a `CancelFrame`, fail the consuming loop).
 */

/** The reserved error tag a liveness expiry surfaces (ADR-0001 §2.7). */
export const TIMEOUT_TAG = '__timeout__';

/**
 * Default idle (stall) window for a streaming call, in milliseconds. Chosen as a
 * conservative ceiling: long enough that a healthy but slow peer (a handler doing
 * real work between frames, a backpressured producer) never trips it, short
 * enough that a genuinely dead call is reclaimed in well under a minute. A
 * deployment with tighter or looser liveness needs overrides it via the
 * transport's `idleTimeout` option; `0`/negative disables the idle timer.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/**
 * Why a liveness timer fired, so the caller can phrase the `__timeout__` message
 * (an idle stall vs. a hard deadline) without re-deriving it.
 */
export type LivenessExpiry = 'idle' | 'deadline';

export interface LivenessOptions {
  /**
   * Idle (stall) window in ms. A frame must arrive within this window of the
   * previous one (or of call open) or the call fails with `__timeout__`. `0`,
   * negative, or `undefined` disables the idle timer.
   */
  idleTimeout?: number;
  /**
   * Overall deadline in ms from call open. A hard ceiling after which the call is
   * cancelled with `__timeout__`. `0`, negative, or `undefined` disables it
   * (the default for streams — they may be long-lived).
   */
  deadline?: number;
  /**
   * Invoked at most ONCE when either timer fires (or, in the case of `idle`, when
   * the idle window elapses with no frame). After this fires the monitor is
   * stopped; the caller performs teardown (unsubscribe, cancel, fail the loop).
   */
  onExpire: (reason: LivenessExpiry) => void;
}

/**
 * A started per-call liveness monitor. {@link notify} resets the idle window
 * (call it on every inbound frame, data or control). {@link stop} cancels both
 * timers idempotently — call it on any terminal frame, fault, completion, or
 * `unregister()` so a finished call never fires a late timeout.
 */
export interface LivenessMonitor {
  /** Reset the idle window: a frame just arrived. No-op once stopped/expired. */
  notify(): void;
  /** Cancel both timers. Idempotent; safe after expiry. */
  stop(): void;
}

/**
 * Start a per-call liveness monitor. The idle timer (if enabled) is armed
 * immediately so a peer that goes silent *before its first frame* is still
 * caught; {@link LivenessMonitor.notify} re-arms it on each frame. The deadline
 * timer (if enabled) is a single one-shot from start. Whichever fires first calls
 * `onExpire` exactly once and stops the monitor.
 */
export function startLivenessMonitor(options: LivenessOptions): LivenessMonitor {
  const idleMs = options.idleTimeout;
  const deadlineMs = options.deadline;
  const idleEnabled = typeof idleMs === 'number' && idleMs > 0;
  const deadlineEnabled = typeof deadlineMs === 'number' && deadlineMs > 0;

  let stopped = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const fire = (reason: LivenessExpiry): void => {
    if (stopped) {
      return;
    }
    stop();
    options.onExpire(reason);
  };

  function stop(): void {
    if (stopped) {
      return;
    }
    stopped = true;
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    }
  }

  function armIdle(): void {
    if (!idleEnabled || stopped) {
      return;
    }
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => fire('idle'), idleMs);
    // Do not keep the process alive solely for a liveness timer.
    idleTimer.unref?.();
  }

  function notify(): void {
    if (stopped) {
      return;
    }
    armIdle();
  }

  // Arm immediately so a peer silent from the very start is caught.
  armIdle();
  if (deadlineEnabled) {
    deadlineTimer = setTimeout(() => fire('deadline'), deadlineMs);
    deadlineTimer.unref?.();
  }

  return { notify, stop };
}
