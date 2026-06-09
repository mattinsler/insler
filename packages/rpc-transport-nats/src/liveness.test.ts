import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_IDLE_TIMEOUT_MS,
  type LivenessExpiry,
  startLivenessMonitor,
  TIMEOUT_TAG,
} from './liveness.js';

// --------------------------------------------------------------------------
// Per-call liveness monitor unit tests (issue 0009, ADR-0001 §2.7).
//
// The monitor is the timer mechanism behind the idle (stall) timeout and the
// optional overall deadline. These unit tests pin its mechanics directly (with
// short windows) so the integration tests can focus on observable transport
// behavior. The reserved tag and default window are part of the contract.
// --------------------------------------------------------------------------

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('liveness monitor — reserved tag & default window', () => {
  test('surfaces the reserved __timeout__ tag', () => {
    expect(TIMEOUT_TAG).toBe('__timeout__');
  });

  test('the default idle window is a sensible positive value', () => {
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBeGreaterThan(0);
    // Documented as a conservative sub-minute ceiling.
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});

describe('liveness monitor — idle (stall) timeout', () => {
  test('fires with reason "idle" when no frame arrives within the window', async () => {
    const reasons: LivenessExpiry[] = [];
    const monitor = startLivenessMonitor({
      idleTimeout: 30,
      onExpire: (reason) => reasons.push(reason),
    });

    await tick(60);
    expect(reasons).toEqual(['idle']);
    monitor.stop();
  });

  test('notify() resets the window — a steady peer never trips it', async () => {
    const reasons: LivenessExpiry[] = [];
    const monitor = startLivenessMonitor({
      idleTimeout: 40,
      onExpire: (reason) => reasons.push(reason),
    });

    // Keep notifying inside the window: the idle timer must keep resetting.
    for (let i = 0; i < 5; i++) {
      await tick(20);
      monitor.notify();
    }
    expect(reasons).toEqual([]);

    // Then go silent: it trips.
    await tick(80);
    expect(reasons).toEqual(['idle']);
    monitor.stop();
  });

  test('disabled when idleTimeout is 0 / negative / undefined', async () => {
    for (const idleTimeout of [0, -5, undefined]) {
      const reasons: LivenessExpiry[] = [];
      const monitor = startLivenessMonitor({ idleTimeout, onExpire: (r) => reasons.push(r) });
      await tick(40);
      expect(reasons).toEqual([]);
      monitor.stop();
    }
  });

  test('stop() prevents a late fire', async () => {
    const reasons: LivenessExpiry[] = [];
    const monitor = startLivenessMonitor({ idleTimeout: 30, onExpire: (r) => reasons.push(r) });
    monitor.stop();
    await tick(60);
    expect(reasons).toEqual([]);
  });
});

describe('liveness monitor — overall deadline (default off)', () => {
  test('fires with reason "deadline" after the hard ceiling regardless of frames', async () => {
    const reasons: LivenessExpiry[] = [];
    const monitor = startLivenessMonitor({
      idleTimeout: 1_000, // long idle, so only the deadline can fire
      deadline: 40,
      onExpire: (reason) => reasons.push(reason),
    });

    // Keep the call "alive" with frames; the deadline must still fire.
    for (let i = 0; i < 4; i++) {
      await tick(15);
      monitor.notify();
    }
    expect(reasons).toEqual(['deadline']);
    monitor.stop();
  });

  test('disabled by default (no deadline option) — never fires on its own', async () => {
    const reasons: LivenessExpiry[] = [];
    const monitor = startLivenessMonitor({
      // no deadline, no idle
      onExpire: (reason) => reasons.push(reason),
    });
    await tick(60);
    expect(reasons).toEqual([]);
    monitor.stop();
  });

  test('fires at most once even if both timers would elapse', async () => {
    const reasons: LivenessExpiry[] = [];
    const monitor = startLivenessMonitor({
      idleTimeout: 20,
      deadline: 20,
      onExpire: (reason) => reasons.push(reason),
    });
    await tick(80);
    expect(reasons).toHaveLength(1);
    monitor.stop();
  });
});
