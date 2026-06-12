import { describe, expect, test } from 'bun:test';

import { EndpointStatsRecorder, StatsStore } from './stats.js';

// --------------------------------------------------------------------------
// Per-endpoint stats accounting (ADR-0001 §1.4) — the recorder/store math in
// isolation: num_requests/num_errors counting, average = total/count, last_error
// formatting, the `started` ISO-8601 instant, and the per-method keying that the
// unary path (issue 0011) and the streaming paths (issue 0012) both record into.
// Wire-level behavior is covered in discovery-stats.test.ts against a real server.
// --------------------------------------------------------------------------

const identity = { name: 'echo', subject: 'rpc.svc.echo', queue_group: 'q' };

describe('EndpointStatsRecorder', () => {
  test('an empty recorder snapshots zeroed counters and no last_error', () => {
    const r = new EndpointStatsRecorder(identity);
    expect(r.snapshot()).toEqual({
      name: 'echo',
      subject: 'rpc.svc.echo',
      queue_group: 'q',
      num_requests: 0,
      num_errors: 0,
      processing_time: 0,
      average_processing_time: 0,
    });
  });

  test('num_requests, total processing_time, and average all track recorded calls', () => {
    const r = new EndpointStatsRecorder(identity);
    r.record({ durationNs: 100 });
    r.record({ durationNs: 200 });
    r.record({ durationNs: 300 });
    const s = r.snapshot();
    expect(s.num_requests).toBe(3);
    expect(s.num_errors).toBe(0);
    expect(s.processing_time).toBe(600);
    // average = total / count.
    expect(s.average_processing_time).toBe(200);
  });

  test('a recorded error increments num_errors and stamps last_error (tag + message)', () => {
    const r = new EndpointStatsRecorder(identity);
    r.record({ durationNs: 10 });
    r.record({ durationNs: 20, error: { _tag: '__validation__', message: 'bad amount' } });
    const s = r.snapshot();
    expect(s.num_requests).toBe(2);
    expect(s.num_errors).toBe(1);
    expect(s.last_error).toBe('__validation__: bad amount');
  });

  test('a declared contract error (non-__*__ tag) also counts and sets last_error', () => {
    const r = new EndpointStatsRecorder(identity);
    r.record({ durationNs: 5, error: { _tag: 'insufficient_funds' } });
    const s = r.snapshot();
    expect(s.num_errors).toBe(1);
    // No message → bare tag.
    expect(s.last_error).toBe('insufficient_funds');
  });

  test('last_error reflects the MOST RECENT error', () => {
    const r = new EndpointStatsRecorder(identity);
    r.record({ durationNs: 1, error: { _tag: 'first' } });
    r.record({ durationNs: 1, error: { _tag: 'second', message: 'later' } });
    expect(r.snapshot().last_error).toBe('second: later');
    expect(r.snapshot().num_errors).toBe(2);
  });

  test('a non-positive/NaN duration still counts the request but does not corrupt the total', () => {
    const r = new EndpointStatsRecorder(identity);
    r.record({ durationNs: 0 });
    r.record({ durationNs: -5 });
    r.record({ durationNs: Number.NaN });
    r.record({ durationNs: 100 });
    const s = r.snapshot();
    expect(s.num_requests).toBe(4);
    expect(s.processing_time).toBe(100);
    expect(s.average_processing_time).toBe(25);
  });
});

describe('StatsStore', () => {
  test('builds one recorder per endpoint, keyed by name, in registration order', () => {
    const store = new StatsStore([
      { name: 'echo', subject: 'rpc.svc.echo', queue_group: 'q' },
      { name: 'other', subject: 'rpc.svc.other', queue_group: 'q' },
    ]);

    store.recorder('echo')?.record({ durationNs: 50 });
    store.recorder('other')?.record({ durationNs: 10, error: { _tag: 'oops' } });

    const snap = store.snapshot();
    expect(snap.map((e) => e.name)).toEqual(['echo', 'other']);
    expect(snap[0]?.num_requests).toBe(1);
    expect(snap[0]?.num_errors).toBe(0);
    expect(snap[1]?.num_requests).toBe(1);
    expect(snap[1]?.num_errors).toBe(1);
  });

  test('recorder() is undefined for an unknown method', () => {
    const store = new StatsStore([{ name: 'echo', subject: 'rpc.svc.echo', queue_group: 'q' }]);
    expect(store.recorder('nope')).toBeUndefined();
  });

  test('started is the registration instant as ISO-8601 UTC', () => {
    const at = new Date('2026-06-07T12:34:56.000Z');
    const store = new StatsStore([], at);
    expect(store.started).toBe('2026-06-07T12:34:56.000Z');
  });

  test('the same recorder accumulates calls regardless of which path records them (0012 seam)', () => {
    // The unary path and the (future) streaming paths both fetch the SAME recorder
    // by method name and call record() — so a method serving both call shapes
    // accumulates into one set of counters.
    const store = new StatsStore([{ name: 'chat', subject: 'rpc.svc.chat', queue_group: 'q' }]);
    const a = store.recorder('chat');
    const b = store.recorder('chat');
    expect(a).toBe(b);
    a?.record({ durationNs: 100 });
    b?.record({ durationNs: 300, error: { _tag: '__transport__' } });
    const s = store.snapshot()[0];
    expect(s?.num_requests).toBe(2);
    expect(s?.num_errors).toBe(1);
    expect(s?.processing_time).toBe(400);
    expect(s?.average_processing_time).toBe(200);
  });
});
