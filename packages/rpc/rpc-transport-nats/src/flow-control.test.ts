import { describe, expect, test } from 'bun:test';

import { CreditController, grantOnConsume } from './flow-control.js';

// --------------------------------------------------------------------------
// Unit tests for the credit machinery (ADR-0001 §2.5). These cover the
// sender-side window (CreditController) and the receiver-side consumption-driven
// grant (grantOnConsume) in isolation, so the wire integration test can focus on
// observable end-to-end backpressure rather than re-deriving the bookkeeping.
// --------------------------------------------------------------------------

describe('CreditController — sender window', () => {
  test('acquire resolves immediately while credit is available, decrementing', async () => {
    const cc = new CreditController(2);
    expect(cc.available).toBe(2);
    await cc.acquire();
    expect(cc.available).toBe(1);
    await cc.acquire();
    expect(cc.available).toBe(0);
  });

  test('at credit 0 the sender pauses; it resumes on the next grant', async () => {
    const cc = new CreditController(1);
    await cc.acquire(); // window now 0

    let resumed = false;
    const parked = cc.acquire().then(() => {
      resumed = true;
    });

    // The parked acquire must NOT resolve until a grant arrives.
    await Promise.resolve();
    await Promise.resolve();
    expect(resumed).toBe(false);

    cc.grant(1);
    await parked;
    expect(resumed).toBe(true);
  });

  test('a grant of n wakes up to n parked senders FIFO', async () => {
    const cc = new CreditController(0);
    const order: number[] = [];
    const a = cc.acquire().then(() => order.push(1));
    const b = cc.acquire().then(() => order.push(2));
    const c = cc.acquire().then(() => order.push(3));

    cc.grant(2); // wakes a and b only
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([1, 2]);
    expect(cc.available).toBe(0);

    cc.grant(1); // wakes c
    await Promise.all([a, b, c]);
    expect(order).toEqual([1, 2, 3]);
  });

  test('surplus credit beyond parked waiters stays in the window', async () => {
    const cc = new CreditController(0);
    const parked = cc.acquire();
    cc.grant(3); // 1 wakes the waiter, 2 remain
    await parked;
    expect(cc.available).toBe(2);
  });

  test('cancel releases parked senders so a paused producer never hangs', async () => {
    const cc = new CreditController(0);
    let released = false;
    const parked = cc.acquire().then(() => {
      released = true;
    });
    cc.cancel();
    await parked;
    expect(released).toBe(true);
  });
});

describe('grantOnConsume — receiver replenishes on application consumption', () => {
  async function* fromArray<T>(items: T[]): AsyncIterable<T> {
    for (const item of items) {
      yield item;
    }
  }

  test('grants exactly once per consumed DataFrame, just before the item is yielded', async () => {
    type F = { t: 'd' } | { t: 'e' };
    const frames: F[] = [{ t: 'd' }, { t: 'd' }, { t: 'e' }];
    const grantsAtPull: number[] = [];
    let grants = 0;

    const wrapped = grantOnConsume<F>(
      fromArray(frames),
      (f) => f.t === 'd',
      () => {
        grants += 1;
      }
    );

    const seen: F[] = [];
    for await (const f of wrapped) {
      // The grant for this item must have already fired by the time the consumer
      // sees it — replenishment is driven by THIS pull (consumption).
      seen.push(f);
      grantsAtPull.push(grants);
    }

    expect(seen).toEqual(frames);
    // Two DataFrames → two grants; the EndFrame grants nothing.
    expect(grants).toBe(2);
    // grant count at each pull: 1 (first data), 2 (second data), 2 (end frame).
    expect(grantsAtPull).toEqual([1, 2, 2]);
  });

  test('non-DataFrames never grant credit', async () => {
    type F = { t: 'c' } | { t: 'e' } | { t: 'x' };
    let grants = 0;
    const wrapped = grantOnConsume<F>(
      fromArray<F>([{ t: 'c' }, { t: 'x' }, { t: 'e' }]),
      (f) => (f as { t: string }).t === 'd',
      () => {
        grants += 1;
      }
    );
    for await (const _ of wrapped) {
      // drain
    }
    expect(grants).toBe(0);
  });

  test('a slow consumer does not run ahead: grants are paced by pulls', async () => {
    // Prove the grant fires per-pull, not eagerly: pause between pulls and assert
    // the grant count tracks the number of items actually consumed so far.
    type F = { t: 'd'; i: number };
    const frames: F[] = [
      { t: 'd', i: 0 },
      { t: 'd', i: 1 },
      { t: 'd', i: 2 },
    ];
    let grants = 0;
    const wrapped = grantOnConsume<F>(
      fromArray(frames),
      () => true,
      () => {
        grants += 1;
      }
    );

    const it = wrapped[Symbol.asyncIterator]();
    expect(grants).toBe(0); // nothing consumed yet → no grant
    await it.next();
    expect(grants).toBe(1);
    await new Promise((r) => setTimeout(r, 10)); // slow consumer
    expect(grants).toBe(1); // still 1 — no eager replenishment
    await it.next();
    expect(grants).toBe(2);
  });
});
