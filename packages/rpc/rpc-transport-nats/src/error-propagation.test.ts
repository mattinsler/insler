import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { Client, ContractError } from '@insler/rpc/client';
import { Contract } from '@insler/rpc/contract';
import { Host } from '@insler/rpc/host';
import { jsonBytesSerde } from '@insler/serde-json';
import type { NatsConnection, Subscription, SubscriptionOptions } from '@nats-io/transport-node';
import { z } from 'zod';

import { createNatsTransport, NatsClientTransport } from './index.js';
import { type EphemeralNatsServer, startEphemeralNatsServer } from './nats-test-harness.js';

// --------------------------------------------------------------------------
// serverStream mid-stream error & fault mapping over NATS (issue 0006,
// ADR-0001 §2.3/§2.4/§2.6).
//
// Propagate errors and transport faults mid-stream with the SAME vocabulary and
// guarantees as unary, mirroring transport-memory's observable behavior:
//   - declared contract error  -> that typed error (throw + result modes), with
//     items yielded before it still delivered;
//   - undeclared host throw     -> __unknown__ (no internals leaked);
//   - frame decode fault        -> __serde__;
//   - seq gap / early close     -> __transport__;
//   - any terminal error frame  -> both directions stop, both inboxes unsubscribe.
//
// Assertions are at the transport boundary (what the Client surfaces / which
// __*__ tag), not internal frame bookkeeping. Faults are injected with a manual
// "host" (a raw NATS subscriber that answers the OpenRequest with crafted frames)
// where the real host wrapper cannot produce the fault (corrupt bytes, seq gap,
// early close).
// --------------------------------------------------------------------------

let server: EphemeralNatsServer;

beforeAll(async () => {
  server = await startEphemeralNatsServer();
});

afterAll(async () => {
  await server.stop();
});

// The canonical parity contract — same shape transport-memory's serverStream
// suite uses (the `StreamFailed` mid-stream error case at
// transport-memory.test.ts), so the observable result compares directly.
const EventService = Contract.create('events', {
  version: '1.0.0',
  methods: {
    watch: {
      kind: 'serverStream' as const,
      input: z.object({ topic: z.string() }),
      output: z.object({ event: z.string(), seq: z.number() }),
    },
  },
});

/**
 * Subscribe a connection's `subscribe`/`unsubscribe` so a test can assert that
 * per-call inboxes (everything subscribed during the call) are torn down. Returns
 * a `live` map of subject -> live (subscribed-but-not-unsubscribed) count.
 */
function trackSubscriptions(connection: NatsConnection): Map<string, number> {
  const live = new Map<string, number>();
  const realSubscribe = connection.subscribe.bind(connection);
  connection.subscribe = ((subject: string, opts?: SubscriptionOptions): Subscription => {
    const sub = realSubscribe(subject, opts);
    live.set(subject, (live.get(subject) ?? 0) + 1);
    const realUnsub = sub.unsubscribe.bind(sub);
    sub.unsubscribe = ((max?: number): void => {
      live.set(subject, (live.get(subject) ?? 1) - 1);
      return realUnsub(max);
    }) as Subscription['unsubscribe'];
    return sub;
  }) as NatsConnection['subscribe'];
  return live;
}

/**
 * A raw "host": subscribe the queue-grouped method subject and, for each
 * OpenRequest, hand the open envelope (with `up`/`down`) plus a per-call `up`
 * frame subscriber to `onOpen`, which crafts the `down` frames to inject a fault.
 * Returns a teardown that unsubscribes the method subscription.
 */
function rawHost(
  connection: NatsConnection,
  onOpen: (
    open: { up: string; down: string; input?: unknown },
    publishDown: (bytes: Uint8Array) => void
  ) => void
): () => void {
  const sub = connection.subscribe('rpc.events.watch', { queue: 'q' });
  void (async () => {
    for await (const msg of sub) {
      const open = jsonBytesSerde.decode(msg.data) as { up: string; down: string; input?: unknown };
      onOpen(open, (bytes) => connection.publish(open.down, bytes));
    }
  })();
  return () => sub.unsubscribe();
}

describe('serverStream over NATS — declared contract error mid-stream', () => {
  // A serverStream contract method with a DECLARED error, so the host wrapper
  // serializes the thrown `{ _tag, payload }` verbatim into the ErrorFrame.
  const FailingService = Contract.create('events', {
    version: '1.0.0',
    methods: {
      watch: {
        kind: 'serverStream' as const,
        input: z.object({ topic: z.string() }),
        output: z.object({ event: z.string(), seq: z.number() }),
        errors: {
          StreamFailed: z.object({ reason: z.string() }),
        },
      },
    },
  });

  test('throw mode: ends as the typed error; prior items remain delivered (mirrors memory)', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });

    const host = await Host.create(
      FailingService,
      {
        async *watch() {
          yield { event: 'before-error', seq: 1 };
          throw { _tag: 'StreamFailed', payload: { reason: 'oops' } };
        },
      } as never,
      hostTransport
    );

    const client = Client.create(FailingService, clientTransport);
    const results: unknown[] = [];
    let caught: ContractError | undefined;
    try {
      for await (const item of client.watch({ topic: 'fail' })) {
        results.push(item);
      }
      expect.unreachable();
    } catch (err) {
      caught = err as ContractError;
    }

    // Same observable result as transport-memory's StreamFailed case.
    expect(caught).toBeInstanceOf(ContractError);
    expect(caught!._tag).toBe('StreamFailed');
    expect(caught!.payload).toEqual({ reason: 'oops' });
    expect(results).toEqual([{ event: 'before-error', seq: 1 }]);

    await host.stop();
    await connection.close();
  });

  test('result mode: ends as { ok: false, error } with the typed tag; prior items delivered', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });

    const host = await Host.create(
      FailingService,
      {
        async *watch() {
          yield { event: 'before-error', seq: 1 };
          throw { _tag: 'StreamFailed', payload: { reason: 'oops' } };
        },
      } as never,
      hostTransport
    );

    // A result-mode client. For serverStream the @insler/rpc/client package surfaces
    // a mid-stream error by throwing a ContractError on the async iterator in
    // BOTH modes (the result wrapper is for the unary/clientStream return value);
    // what this asserts is the transport delivering the SAME typed error so the
    // client can surface it exactly as it would over transport-memory. The result
    // mode is exercised to prove the transport path is mode-agnostic.
    const client = Client.create(FailingService, clientTransport, { errors: 'result' });
    const results: unknown[] = [];
    let caught: ContractError | undefined;
    try {
      for await (const item of client.watch({ topic: 'fail' })) {
        results.push(item);
      }
    } catch (err) {
      caught = err as ContractError;
    }

    expect(caught).toBeInstanceOf(ContractError);
    expect(caught!._tag).toBe('StreamFailed');
    expect(caught!.payload).toEqual({ reason: 'oops' });
    expect(results).toEqual([{ event: 'before-error', seq: 1 }]);

    await host.stop();
    await connection.close();
  });
});

describe('serverStream over NATS — undeclared host throw', () => {
  test('collapses to __unknown__ and never leaks internals', async () => {
    const connection = await server.connect();
    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });

    const host = await Host.create(
      EventService,
      {
        async *watch() {
          yield { event: 'first', seq: 1 };
          // An undeclared throw carrying internal structure. The host wrapper
          // collapses it to `__unknown__`: the contract's declared-error
          // machinery is NOT fooled into surfacing a typed tag, and no structured
          // payload crosses the wire. (Parity: transport-memory surfaces the same
          // `__unknown__` tag with an undefined payload for an undeclared throw.)
          const boom = new Error('internal failure') as Error & { internalDetail?: unknown };
          boom.internalDetail = { dbPassword: 'super-secret-9000' };
          throw boom;
        },
      } as never,
      hostTransport
    );

    const client = Client.create(EventService, clientTransport);
    const results: unknown[] = [];
    let caught: ContractError | undefined;
    try {
      for await (const item of client.watch({ topic: 'boom' })) {
        results.push(item);
      }
      expect.unreachable();
    } catch (err) {
      caught = err as ContractError;
    }

    expect(caught).toBeInstanceOf(ContractError);
    // Collapsed to the reserved tag — never a fabricated declared tag.
    expect(caught!._tag).toBe('__unknown__');
    // No structured internals cross the wire (the attached internalDetail and its
    // secret never reach the client) — same guarantee as transport-memory.
    expect(caught!.payload).toBeUndefined();
    expect(JSON.stringify(caught ?? '')).not.toContain('super-secret-9000');
    // Items yielded before the error remain delivered.
    expect(results).toEqual([{ event: 'first', seq: 1 }]);

    await host.stop();
    await connection.close();
  });
});

describe('serverStream over NATS — frame decode fault', () => {
  test('a frame that fails to decode surfaces as __serde__', async () => {
    const connection = await server.connect();
    // Manual host: answer the open by publishing one valid DataFrame, then a
    // CORRUPT frame (non-JSON bytes) on `down`. The client (jsonBytesSerde) fails
    // to decode it -> __serde__ (the same tag unary uses for wire corruption).
    const teardown = rawHost(connection, (_open, publishDown) => {
      publishDown(jsonBytesSerde.encode({ t: 'd', seq: 0, data: { event: 'ok', seq: 1 } }));
      // Corrupt bytes that are not valid for the JSON serde's decode.
      publishDown(new Uint8Array([0xff, 0xfe, 0xfd, 0x00, 0x01]));
    });

    const clientTransport = new NatsClientTransport({ connection });
    const client = Client.create(EventService, clientTransport);

    const results: unknown[] = [];
    let caught: ContractError | undefined;
    try {
      for await (const item of client.watch({ topic: 'corrupt' })) {
        results.push(item);
      }
      expect.unreachable();
    } catch (err) {
      caught = err as ContractError;
    }

    expect(caught).toBeInstanceOf(ContractError);
    expect(caught!._tag).toBe('__serde__');
    // The valid DataFrame before the corruption was still delivered.
    expect(results).toEqual([{ event: 'ok', seq: 1 }]);

    teardown();
    await connection.close();
  });
});

describe('serverStream over NATS — transport fault', () => {
  test('a detected seq gap on down surfaces as __transport__', async () => {
    const connection = await server.connect();
    // Manual host: publish seq 0, then SKIP to seq 2 (a gap) — a lost frame the
    // client detects via the per-direction monotonic counter -> __transport__.
    const teardown = rawHost(connection, (_open, publishDown) => {
      publishDown(jsonBytesSerde.encode({ t: 'd', seq: 0, data: { event: 'a', seq: 1 } }));
      publishDown(jsonBytesSerde.encode({ t: 'd', seq: 2, data: { event: 'c', seq: 3 } }));
    });

    const clientTransport = new NatsClientTransport({ connection });
    const client = Client.create(EventService, clientTransport);

    const results: unknown[] = [];
    let caught: ContractError | undefined;
    try {
      for await (const item of client.watch({ topic: 'gap' })) {
        results.push(item);
      }
      expect.unreachable();
    } catch (err) {
      caught = err as ContractError;
    }

    expect(caught).toBeInstanceOf(ContractError);
    expect(caught!._tag).toBe('__transport__');
    // The in-sequence frame before the gap was delivered.
    expect(results).toEqual([{ event: 'a', seq: 1 }]);

    teardown();
    await connection.close();
  });

  test('an early close (down ends with no terminal frame) surfaces as __transport__', async () => {
    const connection = await server.connect();
    // Manual host: publish a DataFrame then NOTHING terminal, then tear the
    // method subscription down. From the client's view the `down` channel goes
    // quiet without an EndFrame/ErrorFrame — but a quiet channel alone cannot be
    // distinguished from a slow producer, so we explicitly close the client's
    // connection to force the early-close path deterministically.
    const teardown = rawHost(connection, (_open, publishDown) => {
      publishDown(jsonBytesSerde.encode({ t: 'd', seq: 0, data: { event: 'a', seq: 1 } }));
    });

    const clientConnection = await server.connect();
    const clientTransport = new NatsClientTransport({ connection: clientConnection });
    const client = Client.create(EventService, clientTransport);

    const results: unknown[] = [];
    let caught: ContractError | undefined;
    try {
      for await (const item of client.watch({ topic: 'drop' })) {
        results.push(item);
        // After the first item, drop the client's connection mid-stream.
        await clientConnection.close();
      }
      expect.unreachable();
    } catch (err) {
      caught = err as ContractError;
    }

    expect(caught).toBeInstanceOf(ContractError);
    expect(caught!._tag).toBe('__transport__');
    expect(results).toEqual([{ event: 'a', seq: 1 }]);

    teardown();
    await connection.close();
  });
});

describe('serverStream over NATS — terminal error teardown (no leaks)', () => {
  test('on a terminal ErrorFrame, both directions stop and both inboxes unsubscribe', async () => {
    const connection = await server.connect();
    const live = trackSubscriptions(connection);

    const FailingService = Contract.create('events', {
      version: '1.0.0',
      methods: {
        watch: {
          kind: 'serverStream' as const,
          input: z.object({ topic: z.string() }),
          output: z.object({ event: z.string(), seq: z.number() }),
          errors: { StreamFailed: z.object({ reason: z.string() }) },
        },
      },
    });

    const { client: clientTransport, host: hostTransport } = createNatsTransport({ connection });

    const host = await Host.create(
      FailingService,
      {
        async *watch() {
          yield { event: 'one', seq: 1 };
          throw { _tag: 'StreamFailed', payload: { reason: 'boom' } };
        },
      } as never,
      hostTransport
    );

    const beforeSubjects = new Set(live.keys());

    const client = Client.create(FailingService, clientTransport);
    const results: unknown[] = [];
    let caught: ContractError | undefined;
    try {
      for await (const item of client.watch({ topic: 'leak' })) {
        results.push(item);
      }
    } catch (err) {
      caught = err as ContractError;
    }

    expect(caught!._tag).toBe('StreamFailed');
    expect(results).toEqual([{ event: 'one', seq: 1 }]);

    // Let teardown microtasks/publishes settle.
    await connection.flush();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Every per-call inbox subscription (both `up` and `down`) created during the
    // call must be back to zero — both directions stopped and tore down.
    const perCallSubjects = [...live.keys()].filter((s) => !beforeSubjects.has(s));
    expect(perCallSubjects.length).toBeGreaterThanOrEqual(2);
    for (const subject of perCallSubjects) {
      expect(live.get(subject)).toBe(0);
    }

    await host.stop();
    await connection.close();
  });
});
