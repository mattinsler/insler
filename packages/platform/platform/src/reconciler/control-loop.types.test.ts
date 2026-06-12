import { describe, test } from 'bun:test';

import { expectTypeOf } from 'expect-type';

import type {
  ControlLoop,
  ControlLoopMode,
  ControlLoopOptions,
  DriftAction,
  DriftCategory,
  DriftEvent,
  DriftLog,
  DriftLogEntry,
  ReconcileResult,
  Ticker,
} from './types.js';

/**
 * Issue 0024 — type-level guarantees for the control loop contract. These pin
 * the closed sets (drift categories, actions, mode) and the loop surface so the
 * shape of the policy is enforced at compile time, not only asserted at runtime.
 */

describe('drift category + action contract (AC2, AC5)', () => {
  test('the four drift categories from the issue table are the only members', () => {
    expectTypeOf<DriftCategory>().toEqualTypeOf<
      'replica-count' | 'config-drift' | 'missing-resource' | 'extra-resource'
    >();
  });

  test('a drift event is corrected or alerted — nothing else', () => {
    expectTypeOf<DriftAction>().toEqualTypeOf<'corrected' | 'alerted'>();
  });

  test('the loop runs in development or production only', () => {
    expectTypeOf<ControlLoopMode>().toEqualTypeOf<'development' | 'production'>();
  });
});

describe('DriftEvent contract (AC6, AC7)', () => {
  test('an event carries path, category, action, managed flag, and before/after', () => {
    expectTypeOf<DriftEvent['path']>().toEqualTypeOf<string>();
    expectTypeOf<DriftEvent['category']>().toEqualTypeOf<DriftCategory>();
    expectTypeOf<DriftEvent['managed']>().toEqualTypeOf<boolean>();
    expectTypeOf<DriftEvent['before']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<DriftEvent['after']>().toEqualTypeOf<string | undefined>();
  });
});

describe('DriftLog + DriftLogEntry contract (AC5)', () => {
  test('a log entry is an event + the action taken + a timestamp', () => {
    expectTypeOf<DriftLogEntry['event']>().toEqualTypeOf<DriftEvent>();
    expectTypeOf<DriftLogEntry['action']>().toEqualTypeOf<DriftAction>();
    expectTypeOf<DriftLogEntry['timestamp']>().toEqualTypeOf<string>();
  });

  test('the log sink records a DriftLogEntry', () => {
    expectTypeOf<DriftLog['record']>().parameter(0).toEqualTypeOf<DriftLogEntry>();
  });
});

describe('ControlLoopOptions contract (AC1, AC3, AC4)', () => {
  test('options carry mode, a log, and optional prod auto-correct + clock', () => {
    expectTypeOf<ControlLoopOptions['mode']>().toEqualTypeOf<ControlLoopMode>();
    expectTypeOf<ControlLoopOptions['log']>().toEqualTypeOf<DriftLog>();
    expectTypeOf<ControlLoopOptions['autoCorrectSafeInProduction']>().toEqualTypeOf<
      boolean | undefined
    >();
    expectTypeOf<ControlLoopOptions['now']>().toEqualTypeOf<(() => Date) | undefined>();
  });
});

describe('ReconcileResult + ControlLoop surface (AC1, AC3, AC4, AC5)', () => {
  test('a pass result partitions events into corrected/alerted with a log', () => {
    expectTypeOf<ReconcileResult['events']>().toEqualTypeOf<readonly DriftEvent[]>();
    expectTypeOf<ReconcileResult['corrected']>().toEqualTypeOf<readonly DriftEvent[]>();
    expectTypeOf<ReconcileResult['alerted']>().toEqualTypeOf<readonly DriftEvent[]>();
    expectTypeOf<ReconcileResult['applied']>().toEqualTypeOf<boolean>();
    expectTypeOf<ReconcileResult['log']>().toEqualTypeOf<readonly DriftLogEntry[]>();
  });

  test('reconcileOnce runs one pass; run drives passes off an injectable Ticker', () => {
    expectTypeOf<ControlLoop['reconcileOnce']>().returns.resolves.toEqualTypeOf<ReconcileResult>();
    expectTypeOf<ControlLoop['run']>().parameter(0).toEqualTypeOf<Ticker>();
    expectTypeOf<ControlLoop['run']>().returns.resolves.toEqualTypeOf<readonly ReconcileResult[]>();
    expectTypeOf<Ticker['next']>().returns.resolves.toEqualTypeOf<boolean | void>();
  });
});
