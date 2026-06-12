import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { HostMethodRegistration, HostRegistration } from '@insler/rpc/host';
import { jsonBytesSerde } from '@insler/serde-json';

import type { StatsResponse } from './discovery.js';
import { NatsHostTransport } from './host-transport.js';
import { type EphemeralNatsServer, startEphemeralNatsServer } from './nats-test-harness.js';
import type { EndpointStats } from './stats.js';

// --------------------------------------------------------------------------
// ADR-32 discovery control plane — STATS, unary accounting (issue 0011).
//
// Per `docs/agents/libraries/rpc-transport-nats.md`, wire-level/discovery behavior is
// asserted here against a REAL nats-server (the ephemeral harness from issue 0001),
// not in transport-memory. Each test asserts external, observable behavior at the
// control-plane boundary: what a `$SRV.STATS` request returns — the verbatim
// `io.nats.micro.v1.stats_response` with `started` and per-endpoint `EndpointStats`,
// that unary `num_requests` / `num_errors` / `processing_time` /
// `average_processing_time` track calls (times in ns), that any reserved `__*__`
// tag OR a declared contract error increments `num_errors` and sets `last_error`,
// that all three scopes answer, and `nats micro stats` interop. See ADR-0001 §1.3-1.4.
//
// STREAMING call-level accounting is issue 0012 and is explicitly NOT exercised here.
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

/**
 * A unary handler that echoes its input back, but maps a couple of sentinel inputs
 * to error responses so a test can drive the error-accounting paths through the real
 * host transport:
 *  - `{ fail: 'contract' }` → a DECLARED contract error (a custom, non-`__*__` tag).
 *  - `{ fail: 'validation' }` → a reserved `__validation__` tag.
 * Anything else is a success (output = input).
 */
const echoOrFail: Extract<HostMethodRegistration, { kind: 'unary' }>['handler'] = async (req) => {
  const input = req.input as { fail?: string } | undefined;
  if (input?.fail === 'contract') {
    return {
      error: { _tag: 'insufficient_funds', payload: { balance: 0 }, message: 'not enough funds' },
    };
  }
  if (input?.fail === 'validation') {
    return { error: { _tag: '__validation__', message: 'amount must be a number' } };
  }
  // Add a touch of real work so processing_time is plausibly non-zero ns.
  await Promise.resolve();
  return { output: req.input };
};

/** A registration with two unary methods, so stats are keyed per endpoint. */
function unaryRegistration(service: string): HostRegistration {
  return {
    service,
    methods: [
      { method: 'echo', kind: 'unary', handler: echoOrFail },
      { method: 'other', kind: 'unary', handler: echoOrFail },
    ],
  };
}

/** A registration mixing unary + streaming, to confirm STATS lists every endpoint. */
const serverStreamHandler: Extract<HostMethodRegistration, { kind: 'serverStream' }>['handler'] =
  async function* () {
    // no-op stream
  };
function mixedRegistration(service: string): HostRegistration {
  return {
    service,
    methods: [
      { method: 'echo', kind: 'unary', handler: echoOrFail },
      { method: 'streamThings', kind: 'serverStream', handler: serverStreamHandler },
    ],
  };
}

function decodeStats(data: Uint8Array): StatsResponse {
  return JSON.parse(dec.decode(data)) as StatsResponse;
}

function endpointByName(stats: StatsResponse, name: string): EndpointStats {
  const ep = stats.endpoints.find((e) => e.name === name);
  if (!ep) {
    throw new Error(`No endpoint named '${name}' in STATS response`);
  }
  return ep;
}

/** Issue one unary request to a method subject, returning the decoded reply. */
async function callUnary(
  connection: Awaited<ReturnType<EphemeralNatsServer['connect']>>,
  subject: string,
  input: unknown
): Promise<void> {
  // Encode the WireRequest with the SAME serde the host decodes with (jsonBytesSerde),
  // exactly as the real client transport does — a hand-rolled JSON.stringify would
  // not match the serde's envelope.
  await connection.request(subject, jsonBytesSerde.encode({ input }), { timeout: 2000 });
}

describe('ADR-32 discovery — STATS (unary accounting)', () => {
  test('answers $SRV.STATS with the verbatim io.nats.micro.v1.stats_response, started, and one EndpointStats per method', async () => {
    const connection = await server.connect();
    const host = new NatsHostTransport({ connection, version: '1.2.3' });
    const before = new Date();
    const unregister = await host.register(mixedRegistration('stats-svc'));

    const reply = await connection.request('$SRV.STATS.stats-svc', enc.encode(''), {
      timeout: 2000,
    });
    const stats = decodeStats(reply.data);

    expect(stats.type).toBe('io.nats.micro.v1.stats_response');
    expect(stats.name).toBe('stats-svc');
    expect(typeof stats.id).toBe('string');
    expect(stats.id.length).toBeGreaterThan(0);
    expect(stats.version).toBe('1.2.3');
    expect(stats.metadata).toEqual({});

    // `started` is ISO-8601 UTC at (about) registration time.
    expect(stats.started).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    const started = new Date(stats.started);
    expect(started.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(started.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    // Verbatim: exactly the standard stats_response fields, nothing more/less.
    expect(Object.keys(stats).sort()).toEqual([
      'endpoints',
      'id',
      'metadata',
      'name',
      'started',
      'type',
      'version',
    ]);

    // One EndpointStats per contract method (in registration order), incl. streaming.
    expect(stats.endpoints.map((e) => e.name)).toEqual(['echo', 'streamThings']);

    for (const ep of stats.endpoints) {
      expect(ep.subject).toBe(`rpc.stats-svc.${ep.name}`);
      expect(ep.queue_group).toBe('q');
      // Each EndpointStats has exactly the verbatim fields (no last_error before any
      // error has occurred).
      expect(Object.keys(ep).sort()).toEqual([
        'average_processing_time',
        'name',
        'num_errors',
        'num_requests',
        'processing_time',
        'queue_group',
        'subject',
      ]);
      expect(ep.num_requests).toBe(0);
      expect(ep.num_errors).toBe(0);
      expect(ep.processing_time).toBe(0);
      expect(ep.average_processing_time).toBe(0);
    }

    await unregister();
    await connection.close();
  });

  test('num_requests / processing_time / average_processing_time track unary calls (ns), keyed per endpoint', async () => {
    const connection = await server.connect();
    const host = new NatsHostTransport({ connection, version: '1.0.0' });
    const unregister = await host.register(unaryRegistration('count-svc'));

    // 3 successful calls to `echo`, 1 to `other`.
    await callUnary(connection, 'rpc.count-svc.echo', { n: 1 });
    await callUnary(connection, 'rpc.count-svc.echo', { n: 2 });
    await callUnary(connection, 'rpc.count-svc.echo', { n: 3 });
    await callUnary(connection, 'rpc.count-svc.other', { n: 1 });

    const stats = decodeStats(
      (await connection.request('$SRV.STATS.count-svc', enc.encode(''), { timeout: 2000 })).data
    );

    const echo = endpointByName(stats, 'echo');
    expect(echo.num_requests).toBe(3);
    expect(echo.num_errors).toBe(0);
    expect('last_error' in echo).toBe(false);
    // processing_time is in NANOSECONDS — plausibly non-zero for real handler work.
    expect(echo.processing_time).toBeGreaterThan(0);
    // A real call takes far more than 100ns but far less than 60s (6e10 ns).
    expect(echo.processing_time).toBeLessThan(60_000_000_000);
    // average = total / count (rounded to integer ns).
    expect(echo.average_processing_time).toBe(Math.round(echo.processing_time / 3));
    expect(echo.average_processing_time).toBeGreaterThan(0);

    // Counters are keyed per endpoint: `other` saw exactly one call.
    const other = endpointByName(stats, 'other');
    expect(other.num_requests).toBe(1);
    expect(other.num_errors).toBe(0);
    expect(other.average_processing_time).toBe(other.processing_time);

    await unregister();
    await connection.close();
  });

  test('a declared contract error increments num_errors and sets last_error', async () => {
    const connection = await server.connect();
    const host = new NatsHostTransport({ connection, version: '1.0.0' });
    const unregister = await host.register(unaryRegistration('err-contract-svc'));

    // 2 successes, 1 declared contract error.
    await callUnary(connection, 'rpc.err-contract-svc.echo', { n: 1 });
    await callUnary(connection, 'rpc.err-contract-svc.echo', { fail: 'contract' });
    await callUnary(connection, 'rpc.err-contract-svc.echo', { n: 2 });

    const stats = decodeStats(
      (await connection.request('$SRV.STATS.err-contract-svc', enc.encode(''), { timeout: 2000 }))
        .data
    );
    const echo = endpointByName(stats, 'echo');

    expect(echo.num_requests).toBe(3);
    expect(echo.num_errors).toBe(1);
    // last_error carries the declared tag (and its message).
    expect(echo.last_error).toContain('insufficient_funds');

    await unregister();
    await connection.close();
  });

  test('a reserved __*__ tag (validation) increments num_errors and sets last_error', async () => {
    const connection = await server.connect();
    const host = new NatsHostTransport({ connection, version: '1.0.0' });
    const unregister = await host.register(unaryRegistration('err-validation-svc'));

    await callUnary(connection, 'rpc.err-validation-svc.echo', { fail: 'validation' });

    const stats = decodeStats(
      (
        await connection.request('$SRV.STATS.err-validation-svc', enc.encode(''), {
          timeout: 2000,
        })
      ).data
    );
    const echo = endpointByName(stats, 'echo');

    expect(echo.num_requests).toBe(1);
    expect(echo.num_errors).toBe(1);
    expect(echo.last_error).toContain('__validation__');

    await unregister();
    await connection.close();
  });

  test('a __serde__ tag (undecodable request) increments num_errors and sets last_error', async () => {
    const connection = await server.connect();
    // A serde that always fails to decode forces the host's `__serde__` path, which
    // responds WITHOUT invoking the handler — proving that path is also accounted.
    const failingDecodeSerde = {
      encode: (value: unknown): Uint8Array => enc.encode(JSON.stringify(value)),
      decode: (): unknown => {
        throw new Error('boom');
      },
    };
    const host = new NatsHostTransport({
      connection,
      version: '1.0.0',
      serde: failingDecodeSerde,
    });
    const unregister = await host.register(unaryRegistration('err-serde-svc'));

    // The reply itself is a `__serde__` error; we only care that it returned.
    await connection
      .request('rpc.err-serde-svc.echo', enc.encode('not-decodable'), { timeout: 2000 })
      .catch(() => {});

    // STATS responses are plain JSON, independent of the (broken) injected serde, so
    // the control plane still answers.
    const stats = decodeStats(
      (await connection.request('$SRV.STATS.err-serde-svc', enc.encode(''), { timeout: 2000 })).data
    );
    const echo = endpointByName(stats, 'echo');

    expect(echo.num_requests).toBe(1);
    expect(echo.num_errors).toBe(1);
    expect(echo.last_error).toContain('__serde__');

    await unregister();
    await connection.close();
  });

  test('answers at all three scopes: $SRV.STATS, $SRV.STATS.<name>, $SRV.STATS.<name>.<id>', async () => {
    const connection = await server.connect();
    const host = new NatsHostTransport({ connection, version: '2.0.0' });
    const unregister = await host.register(unaryRegistration('scoped-stats-svc'));

    await callUnary(connection, 'rpc.scoped-stats-svc.echo', { n: 1 });

    const broad = decodeStats(
      (await connection.request('$SRV.STATS', enc.encode(''), { timeout: 2000 })).data
    );
    const id = broad.id;

    const byName = decodeStats(
      (await connection.request('$SRV.STATS.scoped-stats-svc', enc.encode(''), { timeout: 2000 }))
        .data
    );
    const byId = decodeStats(
      (
        await connection.request(`$SRV.STATS.scoped-stats-svc.${id}`, enc.encode(''), {
          timeout: 2000,
        })
      ).data
    );

    for (const stats of [broad, byName, byId]) {
      expect(stats.type).toBe('io.nats.micro.v1.stats_response');
      expect(stats.name).toBe('scoped-stats-svc');
      expect(stats.id).toBe(id);
      expect(stats.version).toBe('2.0.0');
      expect(stats.started).toBe(broad.started);
      // The call we made is reflected across all scopes (one shared store).
      expect(endpointByName(stats, 'echo').num_requests).toBe(1);
    }

    await unregister();
    await connection.close();
  });

  test('interop: `nats micro stats` reports the per-endpoint counters via the harness', async () => {
    const connection = await server.connect();
    const host = new NatsHostTransport({
      connection,
      version: '3.1.4',
      description: 'Interop stats service',
    });
    const unregister = await host.register(unaryRegistration('interop-stats-svc'));

    // Drive some traffic: 2 successes + 1 declared error on `echo`.
    await callUnary(connection, 'rpc.interop-stats-svc.echo', { n: 1 });
    await callUnary(connection, 'rpc.interop-stats-svc.echo', { n: 2 });
    await callUnary(connection, 'rpc.interop-stats-svc.echo', { fail: 'contract' });

    // Isolate the CLI from any local nats context/creds by pointing XDG_CONFIG_HOME
    // at a throwaway dir (XDG_DATA_HOME is left alone so mise shims keep working).
    const cfgHome = await Bun.$`mktemp -d`.text().then((s) => s.trim());
    const env = { ...process.env, XDG_CONFIG_HOME: cfgHome };

    const proc = Bun.spawn(
      ['nats', '--server', server.url, '--timeout=1s', 'micro', 'stats', 'interop-stats-svc'],
      { stdout: 'pipe', stderr: 'pipe', env }
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    expect(stderr).not.toMatch(/error/i);
    // The CLI reports the service and its request/error counts from our verbatim
    // stats_response. 3 requests on `echo`, 1 of them an error.
    expect(stdout).toContain('interop-stats-svc');
    expect(stdout).toMatch(/3/);
    expect(stdout).toMatch(/1/);

    await unregister();
    await connection.close();
  }, 15_000);
});
