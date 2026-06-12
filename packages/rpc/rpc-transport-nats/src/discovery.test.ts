import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { HostRegistration } from '@insler/rpc/host';
import {
  type Msg,
  type NatsConnection,
  NoRespondersError,
  RequestError,
} from '@nats-io/transport-node';

import type { PingResponse } from './discovery.js';
import { NatsHostTransport } from './host-transport.js';
import { type EphemeralNatsServer, startEphemeralNatsServer } from './nats-test-harness.js';

// --------------------------------------------------------------------------
// ADR-32 discovery control plane — PING, name validation, instance id.
//
// Per `docs/agents/libraries/rpc-transport-nats.md`, wire-level/discovery behavior is
// asserted here against a REAL nats-server (the ephemeral harness from issue 0001),
// not in transport-memory. Each test asserts external, observable behavior at the
// control-plane boundary: what a `$SRV.PING` request returns, that all three scopes
// answer, that there is no queue group (every instance answers), that a bad name is
// rejected, and that `unregister()` stops answering.
// --------------------------------------------------------------------------

let server: EphemeralNatsServer;

beforeAll(async () => {
  server = await startEphemeralNatsServer();
});

afterAll(async () => {
  await server.stop();
});

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A trivial registration with one unary method, for standing up a host instance. */
function registration(service: string): HostRegistration {
  return {
    service,
    methods: [{ method: 'echo', kind: 'unary', handler: async (req) => ({ output: req.input }) }],
  };
}

/** Decode a `$SRV.PING` reply payload as the verbatim ADR-32 ping response. */
function decodePing(data: Uint8Array): PingResponse {
  return JSON.parse(dec.decode(data)) as PingResponse;
}

/**
 * Collect every reply to a broadcast request on `subject` within `windowMs`. Used
 * to prove that multiple un-grouped instances ALL answer a single control request
 * (no queue-group load-balancing). Uses a per-call inbox + publish, since
 * `connection.request` returns only the first reply.
 */
async function collectReplies(
  connection: NatsConnection,
  subject: string,
  windowMs = 250
): Promise<Msg[]> {
  const inbox = `_INBOX.collect.${Math.random().toString(36).slice(2)}`;
  const replies: Msg[] = [];
  const sub = connection.subscribe(inbox, {
    callback: (_err, msg) => {
      replies.push(msg);
    },
  });
  connection.publish(subject, enc.encode(''), { reply: inbox });
  await connection.flush();
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  sub.unsubscribe();
  return replies;
}

describe('ADR-32 discovery — PING', () => {
  test('answers $SRV.PING with the verbatim io.nats.micro.v1.ping_response and standard fields', async () => {
    const connection = await server.connect();
    const host = new NatsHostTransport({ connection, version: '1.2.3' });
    const unregister = await host.register(registration('ping-svc'));

    const reply = await connection.request('$SRV.PING', enc.encode(''), { timeout: 2000 });
    const ping = decodePing(reply.data);

    expect(ping.type).toBe('io.nats.micro.v1.ping_response');
    expect(ping.name).toBe('ping-svc');
    expect(typeof ping.id).toBe('string');
    expect(ping.id.length).toBeGreaterThan(0);
    expect(ping.version).toBe('1.2.3');
    expect(ping.metadata).toEqual({});

    // Verbatim: exactly the standard fields, nothing more/less.
    expect(Object.keys(ping).sort()).toEqual(['id', 'metadata', 'name', 'type', 'version']);

    await unregister();
    await connection.close();
  });

  test('answers at all three scopes: $SRV.PING, $SRV.PING.<name>, $SRV.PING.<name>.<id>', async () => {
    const connection = await server.connect();
    const host = new NatsHostTransport({ connection, version: '2.0.0' });
    const unregister = await host.register(registration('scoped-svc'));

    // Discover the minted id via the broad ping first.
    const broad = decodePing(
      (await connection.request('$SRV.PING', enc.encode(''), { timeout: 2000 })).data
    );
    const id = broad.id;

    const byName = decodePing(
      (await connection.request('$SRV.PING.scoped-svc', enc.encode(''), { timeout: 2000 })).data
    );
    const byId = decodePing(
      (await connection.request(`$SRV.PING.scoped-svc.${id}`, enc.encode(''), { timeout: 2000 }))
        .data
    );

    for (const ping of [broad, byName, byId]) {
      expect(ping.type).toBe('io.nats.micro.v1.ping_response');
      expect(ping.name).toBe('scoped-svc');
      expect(ping.id).toBe(id);
      expect(ping.version).toBe('2.0.0');
    }

    await unregister();
    await connection.close();
  });

  test('control subscriptions use NO queue group — every instance answers (2 instances → 2 replies)', async () => {
    // Two independent host instances of the same service on two connections.
    const connA = await server.connect();
    const connB = await server.connect();
    const hostA = new NatsHostTransport({ connection: connA, version: '1.0.0' });
    const hostB = new NatsHostTransport({ connection: connB, version: '1.0.0' });
    const unregA = await hostA.register(registration('fleet-svc'));
    const unregB = await hostB.register(registration('fleet-svc'));

    const requester = await server.connect();
    const replies = await collectReplies(requester, '$SRV.PING');
    const pings = replies.map((m) => decodePing(m.data));
    const ids = new Set(pings.map((p) => p.id));

    // Both instances answered a single broadcast PING (no load-balancing).
    expect(pings.length).toBe(2);
    expect(ids.size).toBe(2);
    expect(pings.every((p) => p.name === 'fleet-svc')).toBe(true);

    await unregA();
    await unregB();
    await connA.close();
    await connB.close();
    await requester.close();
  });

  test('a unique id is minted per register() and is stable for that registration lifetime', async () => {
    const connection = await server.connect();
    const host = new NatsHostTransport({ connection, version: '1.0.0' });

    const unregA = await host.register(registration('id-svc-a'));
    const unregB = await host.register(registration('id-svc-b'));

    const idA1 = decodePing(
      (await connection.request('$SRV.PING.id-svc-a', enc.encode(''), { timeout: 2000 })).data
    ).id;
    const idA2 = decodePing(
      (await connection.request('$SRV.PING.id-svc-a', enc.encode(''), { timeout: 2000 })).data
    ).id;
    const idB = decodePing(
      (await connection.request('$SRV.PING.id-svc-b', enc.encode(''), { timeout: 2000 })).data
    ).id;

    // Stable across pings for the same registration...
    expect(idA1).toBe(idA2);
    // ...and unique per register().
    expect(idA1).not.toBe(idB);

    await unregA();
    await unregB();
    await connection.close();
  });

  test('register() rejects a service name outside the ADR-32 charset with a clear error', async () => {
    const connection = await server.connect();
    const host = new NatsHostTransport({ connection });

    // '.' is outside A-Z a-z 0-9 - _ (and is also a NATS subject token separator).
    await expect(host.register(registration('bad.name'))).rejects.toThrow(/ADR-32|charset/i);
    // A space is likewise rejected.
    await expect(host.register(registration('bad name'))).rejects.toThrow(
      /Invalid NATS service name/i
    );
    // Empty is rejected.
    await expect(host.register(registration(''))).rejects.toThrow(/Invalid NATS service name/i);

    // A valid name with every allowed class is accepted.
    const unregister = await host.register(registration('Good_Service-99'));
    const ping = decodePing(
      (await connection.request('$SRV.PING.Good_Service-99', enc.encode(''), { timeout: 2000 }))
        .data
    );
    expect(ping.name).toBe('Good_Service-99');

    await unregister();
    await connection.close();
  });

  test('interop: `nats micro ping` sees the service via the harness', async () => {
    const connection = await server.connect();
    const host = new NatsHostTransport({ connection, version: '3.1.4' });
    const unregister = await host.register(registration('interop-svc'));

    // Isolate the CLI from any local nats context/creds by pointing XDG_CONFIG_HOME
    // at a throwaway dir (XDG_DATA_HOME is left alone so mise shims keep working).
    // `--timeout=1s` shortens the CLI's response-gather window (default 5s) so the
    // test doesn't pay the full discovery wait.
    const cfgHome = await Bun.$`mktemp -d`.text().then((s) => s.trim());
    const proc = Bun.spawn(['nats', '--server', server.url, '--timeout=1s', 'micro', 'ping'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, XDG_CONFIG_HOME: cfgHome },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    expect(stderr).not.toMatch(/error/i);
    // The CLI prints the service name and the minted id for the instance it pinged.
    expect(stdout).toContain('interop-svc');

    await unregister();
    await connection.close();
  }, 15_000);

  test('unregister() unsubscribes the control subjects — pings stop being answered', async () => {
    const connection = await server.connect();
    const host = new NatsHostTransport({ connection, version: '1.0.0' });
    const unregister = await host.register(registration('teardown-svc'));

    // Answered while registered.
    const before = decodePing(
      (await connection.request('$SRV.PING.teardown-svc', enc.encode(''), { timeout: 2000 })).data
    );
    expect(before.name).toBe('teardown-svc');

    await unregister();

    // After teardown there are no responders: the request errors with
    // no-responders / 503 rather than returning a ping.
    let noResponder = false;
    try {
      await connection.request('$SRV.PING.teardown-svc', enc.encode(''), {
        timeout: 1000,
        noMux: true,
      });
    } catch (err) {
      noResponder =
        err instanceof NoRespondersError ||
        err instanceof RequestError ||
        (err instanceof Error && /503|no responders|timeout/i.test(err.message));
    }
    expect(noResponder).toBe(true);

    await connection.close();
  });
});
