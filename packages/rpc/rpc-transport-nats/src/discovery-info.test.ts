import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { HostMethodRegistration, HostRegistration } from '@insler/rpc/host';

import type { EndpointInfo, InfoResponse } from './discovery.js';
import { NatsHostTransport } from './host-transport.js';
import { type EphemeralNatsServer, startEphemeralNatsServer } from './nats-test-harness.js';

// --------------------------------------------------------------------------
// ADR-32 discovery control plane — INFO endpoint mapping & metadata.
//
// Per `docs/agents/libraries/rpc-transport-nats.md`, wire-level/discovery behavior is
// asserted here against a REAL nats-server (the ephemeral harness from issue 0001),
// not in transport-memory. Each test asserts external, observable behavior at the
// control-plane boundary: what a `$SRV.INFO` request returns — the verbatim
// `io.nats.micro.v1.info_response`, its `description`, one `EndpointInfo` per method
// with the correct subject/queue_group/metadata, the per-endpoint
// `dev.insler.rpc.kind`/`dev.insler.rpc.contract_version` descriptors, the
// pass-through schema fingerprints, that all three scopes answer, and `nats micro
// info` interop. See ADR-0001 §1.3-1.4.
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

/** A handler stub of each kind, just enough to register the method. */
const unaryHandler: Extract<HostMethodRegistration, { kind: 'unary' }>['handler'] = async (
  req
) => ({
  output: req.input,
});
const serverStreamHandler: Extract<HostMethodRegistration, { kind: 'serverStream' }>['handler'] =
  async function* () {
    // no-op stream
  };
const clientStreamHandler: Extract<
  HostMethodRegistration,
  { kind: 'clientStream' }
>['handler'] = async () => ({ output: undefined });
const duplexHandler: Extract<HostMethodRegistration, { kind: 'duplex' }>['handler'] =
  async function* () {
    // no-op stream
  };

/**
 * A registration with a MIX of method kinds, so each endpoint's advertised
 * `dev.insler.rpc.kind` is distinguishable on the INFO response.
 */
function mixedKindRegistration(service: string): HostRegistration {
  return {
    service,
    methods: [
      { method: 'getThing', kind: 'unary', handler: unaryHandler },
      { method: 'streamThings', kind: 'serverStream', handler: serverStreamHandler },
      { method: 'uploadThings', kind: 'clientStream', handler: clientStreamHandler },
      { method: 'chat', kind: 'duplex', handler: duplexHandler },
    ],
  };
}

/** Decode a `$SRV.INFO` reply payload as the verbatim ADR-32 info response. */
function decodeInfo(data: Uint8Array): InfoResponse {
  return JSON.parse(dec.decode(data)) as InfoResponse;
}

function endpointByName(info: InfoResponse, name: string): EndpointInfo {
  const ep = info.endpoints.find((e) => e.name === name);
  if (!ep) {
    throw new Error(`No endpoint named '${name}' in INFO response`);
  }
  return ep;
}

describe('ADR-32 discovery — INFO', () => {
  test('answers $SRV.INFO with the verbatim io.nats.micro.v1.info_response, description, and one endpoint per method', async () => {
    const connection = await server.connect();
    const host = new NatsHostTransport({
      connection,
      version: '1.2.3',
      description: 'The thing service',
    });
    const unregister = await host.register(mixedKindRegistration('info-svc'));

    const reply = await connection.request('$SRV.INFO', enc.encode(''), { timeout: 2000 });
    const info = decodeInfo(reply.data);

    expect(info.type).toBe('io.nats.micro.v1.info_response');
    expect(info.name).toBe('info-svc');
    expect(typeof info.id).toBe('string');
    expect(info.id.length).toBeGreaterThan(0);
    expect(info.version).toBe('1.2.3');
    expect(info.metadata).toEqual({});
    expect(info.description).toBe('The thing service');

    // One EndpointInfo per contract method (in registration order).
    expect(info.endpoints.map((e) => e.name)).toEqual([
      'getThing',
      'streamThings',
      'uploadThings',
      'chat',
    ]);

    // Verbatim: exactly the standard info_response fields, nothing more/less.
    expect(Object.keys(info).sort()).toEqual([
      'description',
      'endpoints',
      'id',
      'metadata',
      'name',
      'type',
      'version',
    ]);

    await unregister();
    await connection.close();
  });

  test('description defaults to the empty string when not supplied', async () => {
    const connection = await server.connect();
    const host = new NatsHostTransport({ connection, version: '1.0.0' });
    const unregister = await host.register(mixedKindRegistration('no-desc-svc'));

    const info = decodeInfo(
      (await connection.request('$SRV.INFO', enc.encode(''), { timeout: 2000 })).data
    );
    expect(info.description).toBe('');

    await unregister();
    await connection.close();
  });

  test('each endpoint reports the correct subject and queue_group (defaults rpc / q)', async () => {
    const connection = await server.connect();
    const host = new NatsHostTransport({ connection, version: '1.0.0' });
    const unregister = await host.register(mixedKindRegistration('subj-svc'));

    const info = decodeInfo(
      (await connection.request('$SRV.INFO', enc.encode(''), { timeout: 2000 })).data
    );

    for (const ep of info.endpoints) {
      expect(ep.subject).toBe(`rpc.subj-svc.${ep.name}`);
      expect(ep.queue_group).toBe('q');
      // Each EndpointInfo is exactly { name, subject, queue_group, metadata }.
      expect(Object.keys(ep).sort()).toEqual(['metadata', 'name', 'queue_group', 'subject']);
    }

    await unregister();
    await connection.close();
  });

  test('endpoint subject/queue_group honor a custom subjectPrefix and queue', async () => {
    const connection = await server.connect();
    const host = new NatsHostTransport({
      connection,
      version: '1.0.0',
      subjectPrefix: 'svc',
      queue: 'workers',
    });
    const unregister = await host.register(mixedKindRegistration('custom-svc'));

    const info = decodeInfo(
      (await connection.request('$SRV.INFO', enc.encode(''), { timeout: 2000 })).data
    );

    const getThing = endpointByName(info, 'getThing');
    expect(getThing.subject).toBe('svc.custom-svc.getThing');
    expect(getThing.queue_group).toBe('workers');

    await unregister();
    await connection.close();
  });

  test('per-endpoint metadata advertises dev.insler.rpc.kind (per method kind) and contract_version', async () => {
    const connection = await server.connect();
    const host = new NatsHostTransport({ connection, version: '4.5.6' });
    const unregister = await host.register(mixedKindRegistration('kinds-svc'));

    const info = decodeInfo(
      (await connection.request('$SRV.INFO', enc.encode(''), { timeout: 2000 })).data
    );

    // Each endpoint's kind comes straight off the registration — the mix is
    // distinguishable on the wire.
    expect(endpointByName(info, 'getThing').metadata['dev.insler.rpc.kind']).toBe('unary');
    expect(endpointByName(info, 'streamThings').metadata['dev.insler.rpc.kind']).toBe(
      'serverStream'
    );
    expect(endpointByName(info, 'uploadThings').metadata['dev.insler.rpc.kind']).toBe(
      'clientStream'
    );
    expect(endpointByName(info, 'chat').metadata['dev.insler.rpc.kind']).toBe('duplex');

    // Contract version is advertised per endpoint.
    for (const ep of info.endpoints) {
      expect(ep.metadata['dev.insler.rpc.contract_version']).toBe('4.5.6');
    }

    await unregister();
    await connection.close();
  });

  test('a supplied fingerprint is published as dev.insler.rpc.input/output; absent otherwise', async () => {
    const connection = await server.connect();
    const host = new NatsHostTransport({
      connection,
      version: '1.0.0',
      fingerprints: {
        // Both directions supplied.
        getThing: { input: 'in-abc', output: 'out-def' },
        // Only output supplied.
        chat: { output: 'out-chat' },
        // streamThings / uploadThings: no fingerprint supplied at all.
      },
    });
    const unregister = await host.register(mixedKindRegistration('fp-svc'));

    const info = decodeInfo(
      (await connection.request('$SRV.INFO', enc.encode(''), { timeout: 2000 })).data
    );

    const getThing = endpointByName(info, 'getThing');
    expect(getThing.metadata['dev.insler.rpc.input']).toBe('in-abc');
    expect(getThing.metadata['dev.insler.rpc.output']).toBe('out-def');

    const chat = endpointByName(info, 'chat');
    expect(chat.metadata['dev.insler.rpc.output']).toBe('out-chat');
    // Input was NOT supplied for chat — it must be absent (not published).
    expect('dev.insler.rpc.input' in chat.metadata).toBe(false);

    // No fingerprint supplied at all → both keys absent.
    const streamThings = endpointByName(info, 'streamThings');
    expect('dev.insler.rpc.input' in streamThings.metadata).toBe(false);
    expect('dev.insler.rpc.output' in streamThings.metadata).toBe(false);

    await unregister();
    await connection.close();
  });

  test('answers at all three scopes: $SRV.INFO, $SRV.INFO.<name>, $SRV.INFO.<name>.<id>', async () => {
    const connection = await server.connect();
    const host = new NatsHostTransport({ connection, version: '2.0.0' });
    const unregister = await host.register(mixedKindRegistration('scoped-info-svc'));

    // Discover the minted id via the broad info first.
    const broad = decodeInfo(
      (await connection.request('$SRV.INFO', enc.encode(''), { timeout: 2000 })).data
    );
    const id = broad.id;

    const byName = decodeInfo(
      (await connection.request('$SRV.INFO.scoped-info-svc', enc.encode(''), { timeout: 2000 }))
        .data
    );
    const byId = decodeInfo(
      (
        await connection.request(`$SRV.INFO.scoped-info-svc.${id}`, enc.encode(''), {
          timeout: 2000,
        })
      ).data
    );

    for (const info of [broad, byName, byId]) {
      expect(info.type).toBe('io.nats.micro.v1.info_response');
      expect(info.name).toBe('scoped-info-svc');
      expect(info.id).toBe(id);
      expect(info.version).toBe('2.0.0');
      expect(info.endpoints.map((e) => e.name)).toEqual([
        'getThing',
        'streamThings',
        'uploadThings',
        'chat',
      ]);
    }

    await unregister();
    await connection.close();
  });

  test('interop: the `nats` CLI discovers the service via $SRV.INFO and lists its endpoints', async () => {
    const connection = await server.connect();
    const host = new NatsHostTransport({
      connection,
      version: '3.1.4',
      description: 'Interop info service',
    });
    const unregister = await host.register(mixedKindRegistration('interop-info-svc'));

    // Isolate the CLI from any local nats context/creds by pointing XDG_CONFIG_HOME
    // at a throwaway dir (XDG_DATA_HOME is left alone so mise shims keep working).
    const cfgHome = await Bun.$`mktemp -d`.text().then((s) => s.trim());
    const env = { ...process.env, XDG_CONFIG_HOME: cfgHome };

    const runNats = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
      const proc = Bun.spawn(['nats', '--server', server.url, '--timeout=1s', ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
        env,
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      return { stdout, stderr };
    };

    // `nats micro ls` is driven SOLELY by `$SRV.INFO` (a single broadcast — verified
    // by sniffing the control plane): the CLI lists the service straight from our
    // verbatim info_response. This proves INFO is interop-parseable by off-the-shelf
    // ADR-32 tooling, with no STATS dependency.
    const ls = await runNats(['micro', 'ls']);
    expect(ls.stderr).not.toMatch(/error/i);
    expect(ls.stdout).toContain('interop-info-svc');
    expect(ls.stdout).toContain('3.1.4');
    expect(ls.stdout).toContain('Interop info service');

    // The endpoint LIST is part of the INFO response the CLI consumed. Per-endpoint
    // introspection via `nats micro info <name>` additionally issues `$SRV.STATS`
    // (CLI 0.4.0 couples INFO+STATS), which is out of scope here (STATS is issues
    // 0011/0012). So the endpoint inventory the CLI received is asserted directly on
    // the INFO response the CLI itself uses, rather than through the STATS-coupled
    // `info` subcommand.
    const info = decodeInfo(
      (await connection.request('$SRV.INFO.interop-info-svc', enc.encode(''), { timeout: 2000 }))
        .data
    );
    expect(info.endpoints.map((e) => e.name)).toEqual([
      'getThing',
      'streamThings',
      'uploadThings',
      'chat',
    ]);

    await unregister();
    await connection.close();
  }, 15_000);
});
