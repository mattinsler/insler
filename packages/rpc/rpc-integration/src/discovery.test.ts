import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  createNatsTransport,
  type InfoResponse,
  type PingResponse,
  type StatsResponse,
} from '@insler/rpc-transport-nats';
import { Client, ContractError } from '@insler/rpc/client';
import { Contract } from '@insler/rpc/contract';
import { Host } from '@insler/rpc/host';
import { cborSerde } from '@insler/serde-cbor';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import { z } from 'zod';

import { type EphemeralNatsServer, startNatsServer } from './nats-server.js';

// The discovery plane against real `nats micro` semantics (subsystem-branding
// issue 0006): a service stood up purely through the public surface
// (Contract.create + Host.create + createNatsTransport) answers the ADR-32
// `$SRV.PING/INFO/STATS` control plane with verbatim `io.nats.micro.v1.*`
// responses that off-the-shelf tooling — the `nats` CLI from the mise
// toolchain — discovers and parses. Assertions are at the control-plane
// boundary an operator observes: raw `$SRV` requests over the consumer-owned
// connection and the CLI's output, never the adapter's internals.

const inventory = Contract.create('inventory', {
  version: '2.1.0',
  methods: {
    getItem: {
      input: z.object({ sku: z.string() }),
      output: z.object({ sku: z.string(), stock: z.number() }),
      errors: { ItemMissing: z.object({ sku: z.string() }) },
    },
    watchItems: {
      kind: 'serverStream',
      input: z.object({ prefix: z.string() }),
      output: z.object({ sku: z.string() }),
    },
    uploadItems: {
      kind: 'clientStream',
      input: z.object({ sku: z.string() }),
      output: z.object({ count: z.number() }),
    },
    syncItems: {
      kind: 'duplex',
      input: z.object({ sku: z.string() }),
      output: z.object({ sku: z.string() }),
    },
  },
});

const inventoryHandlers: Contract.Handlers<typeof inventory> = {
  getItem: async ({ sku }) => {
    if (sku === 'missing') throw { _tag: 'ItemMissing', payload: { sku } };
    return { sku, stock: 5 };
  },
  watchItems: async function* ({ prefix }) {
    yield { sku: `${prefix}-1` };
  },
  uploadItems: async (inputStream) => {
    let count = 0;
    for await (const _item of inputStream) count += 1;
    return { count };
  },
  syncItems: async function* (inputStream) {
    for await (const item of inputStream) yield item;
  },
};

let server: EphemeralNatsServer;
let connection: NatsConnection;
let host: { stop(): Promise<void> };
let client: Contract.Client<typeof inventory>;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Issue a `$SRV.*` control request and parse the (always plain-JSON) reply. */
async function control<T>(subject: string): Promise<T> {
  const reply = await connection.request(subject, enc.encode(''), { timeout: 2000 });
  return JSON.parse(dec.decode(reply.data)) as T;
}

/** Run the `nats` CLI against the suite's server, isolated from local config. */
async function runNatsCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  // XDG_CONFIG_HOME points at a throwaway dir so a local nats context/creds
  // can't leak in (XDG_DATA_HOME is left alone so mise shims keep working).
  // `--timeout=1s` shortens the CLI's discovery-gather window (default 5s).
  const cfgHome = await Bun.$`mktemp -d`.text().then((s) => s.trim());
  const proc = Bun.spawn(['nats', '--server', server.url, '--timeout=1s', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, XDG_CONFIG_HOME: cfgHome },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { stdout, stderr };
}

beforeAll(async () => {
  server = await startNatsServer();
  connection = await connect({ servers: server.url });
  const transport = createNatsTransport({
    connection,
    version: '2.1.0',
    description: 'Inventory service',
  });
  host = await Host.create(inventory, inventoryHandlers, transport.host);
  client = Client.create(inventory, transport.client);
});

afterAll(async () => {
  await host?.stop();
  await connection?.close();
  await server?.stop();
});

describe('discovery plane — $SRV control requests (nats micro semantics)', () => {
  test('$SRV.PING.<name> answers the verbatim io.nats.micro.v1.ping_response', async () => {
    const ping = await control<PingResponse>('$SRV.PING.inventory');

    expect(ping.type).toBe('io.nats.micro.v1.ping_response');
    expect(ping.name).toBe('inventory');
    expect(typeof ping.id).toBe('string');
    expect(ping.id.length).toBeGreaterThan(0);
    expect(ping.version).toBe('2.1.0');
    // Verbatim ADR-32: exactly the standard fields, nothing more/less.
    expect(Object.keys(ping).sort()).toEqual(['id', 'metadata', 'name', 'type', 'version']);
  });

  test('$SRV.INFO.<name> advertises one endpoint per contract method, with subject, queue group, and method kind', async () => {
    const info = await control<InfoResponse>('$SRV.INFO.inventory');

    expect(info.type).toBe('io.nats.micro.v1.info_response');
    expect(info.name).toBe('inventory');
    expect(info.version).toBe('2.1.0');
    expect(info.description).toBe('Inventory service');

    // One endpoint per contract method, in contract order.
    expect(info.endpoints.map((e) => e.name)).toEqual([
      'getItem',
      'watchItems',
      'uploadItems',
      'syncItems',
    ]);

    // Default subject layout + queue group, and the per-endpoint metadata
    // documenting each method's kind and contract version.
    const kinds: Record<string, string> = {
      getItem: 'unary',
      watchItems: 'serverStream',
      uploadItems: 'clientStream',
      syncItems: 'duplex',
    };
    for (const ep of info.endpoints) {
      expect(ep.subject).toBe(`rpc.inventory.${ep.name}`);
      expect(ep.queue_group).toBe('q');
      expect(ep.metadata['dev.insler.rpc.kind']).toBe(kinds[ep.name]);
      expect(ep.metadata['dev.insler.rpc.contract_version']).toBe('2.1.0');
    }
  });

  test('$SRV.STATS.<name> accounts requests and errors driven through the typed client', async () => {
    // Drive observable traffic: two successes + one declared contract error.
    await expect(client.getItem({ sku: 'sku-1' })).resolves.toEqual({ sku: 'sku-1', stock: 5 });
    await expect(client.getItem({ sku: 'sku-2' })).resolves.toEqual({ sku: 'sku-2', stock: 5 });
    const error = await client.getItem({ sku: 'missing' }).then(
      () => {
        throw new Error('expected getItem to reject');
      },
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError)._tag).toBe('ItemMissing');

    const stats = await control<StatsResponse>('$SRV.STATS.inventory');

    expect(stats.type).toBe('io.nats.micro.v1.stats_response');
    expect(stats.name).toBe('inventory');
    expect(stats.started).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(stats.endpoints.map((e) => e.name)).toEqual([
      'getItem',
      'watchItems',
      'uploadItems',
      'syncItems',
    ]);

    const getItem = stats.endpoints.find((e) => e.name === 'getItem');
    expect(getItem).toBeDefined();
    expect(getItem!.num_requests).toBeGreaterThanOrEqual(3);
    expect(getItem!.num_errors).toBeGreaterThanOrEqual(1);
    expect(getItem!.processing_time).toBeGreaterThan(0);
  });

  test('control-plane responses stay plain JSON even when the application serde is binary (CBOR)', async () => {
    // Stand up a second service whose RPC plane rides CBOR; standard ADR-32
    // tooling must still parse its control plane (JSON by contract).
    const cborTransport = createNatsTransport({
      connection,
      serde: cborSerde,
      version: '0.9.0',
    });
    const cborHost = await Host.create(
      Contract.create('cbor-svc', {
        version: '0.9.0',
        methods: { noop: { input: z.object({}), output: z.object({}) } },
      }),
      { noop: async () => ({}) },
      cborTransport.host
    );

    try {
      const ping = await control<PingResponse>('$SRV.PING.cbor-svc');
      expect(ping.type).toBe('io.nats.micro.v1.ping_response');
      expect(ping.name).toBe('cbor-svc');
      const info = await control<InfoResponse>('$SRV.INFO.cbor-svc');
      expect(info.type).toBe('io.nats.micro.v1.info_response');
      expect(info.endpoints.map((e) => e.name)).toEqual(['noop']);
    } finally {
      await cborHost.stop();
    }
  });

  test('stop() leaves the discovery plane — $SRV.PING.<name> has no responders afterwards', async () => {
    const transport = createNatsTransport({ connection, version: '1.0.0' });
    const ephemeralHost = await Host.create(
      Contract.create('ephemeral-svc', {
        version: '1.0.0',
        methods: { noop: { input: z.object({}), output: z.object({}) } },
      }),
      { noop: async () => ({}) },
      transport.host
    );

    // Answers while running...
    const ping = await control<PingResponse>('$SRV.PING.ephemeral-svc');
    expect(ping.name).toBe('ephemeral-svc');

    await ephemeralHost.stop();

    // ...and disappears once stopped: the request fails (503 / no responders /
    // timeout) instead of returning a ping.
    let gone = false;
    try {
      await connection.request('$SRV.PING.ephemeral-svc', enc.encode(''), {
        timeout: 1000,
        noMux: true,
      });
    } catch (err) {
      gone = err instanceof Error;
    }
    expect(gone).toBe(true);
  });
});

describe('discovery plane — `nats micro` CLI interop', () => {
  test('the nats CLI discovers and describes the service ($SRV-driven ping + ls)', async () => {
    // `nats micro ping` broadcasts $SRV.PING and prints each responder.
    const ping = await runNatsCli(['micro', 'ping']);
    expect(ping.stderr).not.toMatch(/error/i);
    expect(ping.stdout).toContain('inventory');

    // `nats micro ls` is driven by $SRV.INFO: name, version, and description
    // come straight from the verbatim info_response.
    const ls = await runNatsCli(['micro', 'ls']);
    expect(ls.stderr).not.toMatch(/error/i);
    expect(ls.stdout).toContain('inventory');
    expect(ls.stdout).toContain('2.1.0');
    expect(ls.stdout).toContain('Inventory service');
  }, 15_000);

  test('`nats micro stats` reports the per-endpoint counters', async () => {
    // Ensure there is at least one counted request on getItem.
    await client.getItem({ sku: 'sku-cli' });

    const stats = await runNatsCli(['micro', 'stats', 'inventory']);
    expect(stats.stderr).not.toMatch(/error/i);
    expect(stats.stdout).toContain('inventory');
    expect(stats.stdout).toContain('getItem');
  }, 15_000);
});
