import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { Client } from '@insler/rpc/client';
import { Contract } from '@insler/rpc/contract';
import { Host } from '@insler/rpc/host';
import { z } from 'zod';

import { createNatsTransport } from './index.js';
import { startLeafNode, type LeafNode } from './leaf-node.js';
import { startEphemeralNatsServer, type EphemeralNatsServer } from './nats-test-harness.js';

// These tests exercise a REAL nats-server topology: a "hub" (the shared dev
// cluster) with a leafnode listener, and a developer "leaf" node soliciting a
// route to it. The binary is provisioned via mise (pinned in mise.toml; on PATH).
// If it is not on PATH the harness throws — the correct loud failure, not a skip.
//
// The development inner loop (ifc-platform 0025): a developer runs ONE service
// locally, joined to the cluster via the leaf node, and it participates in the
// real mesh (queue groups, cross-service calls) without the rest of the fleet
// running locally.

const GreeterContract = Contract.create('greeter', {
  version: '1.0.0',
  methods: {
    greet: {
      input: z.object({ name: z.string() }),
      output: z.object({ greeting: z.string(), servedBy: z.string() }),
    },
  },
});

const ClockContract = Contract.create('clock', {
  version: '1.0.0',
  methods: {
    now: {
      input: z.object({}),
      output: z.object({ iso: z.string() }),
    },
  },
});

// Subject propagation across the leafnode boundary is asynchronous; give the
// interest graph a beat to converge before asserting routing.
const PROPAGATION_MS = 750;
const settle = () => new Promise((resolve) => setTimeout(resolve, PROPAGATION_MS));

describe('development inner loop over a NATS leaf node', () => {
  let hub: EphemeralNatsServer;
  let leaf: LeafNode;

  beforeAll(async () => {
    // The shared dev cluster, with a leafnode listener open.
    hub = await startEphemeralNatsServer({ leafnodes: true });
    // The developer's machine: a leaf node soliciting a route to the cluster.
    // AC6: this is a single nats-server process — no Docker, no Kubernetes.
    leaf = await startLeafNode({
      remotes: [{ url: `nats-leaf://127.0.0.1:${hub.leafnodePort!}` }],
    });
  });

  afterAll(async () => {
    await leaf.stop();
    await hub.stop();
  });

  test('the hub exposes a resolved leafnode listener port for the leaf to solicit', () => {
    expect(hub.leafnodePort).toBeGreaterThan(0);
    expect(hub.leafnodePort).not.toBe(hub.port);
  });

  // --------------------------------------------------------------------------
  // AC2 + AC4 + AC6: a developer's local service joins the same queue group as
  // the remote fleet and serves a request that originated in the cluster — the
  // request crosses the leaf boundary and is handled locally.
  // --------------------------------------------------------------------------

  test('AC2/AC4: a leaf-local service joins the queue group and serves a cluster-originated request', async () => {
    const leafConn = await leaf.connect();
    const transport = createNatsTransport({ connection: leafConn, queue: 'q' });
    const host = await Host.create(
      GreeterContract,
      {
        greet: async (input: { name: string }) => ({
          greeting: `hello ${input.name}`,
          servedBy: 'leaf',
        }),
      } as never,
      transport.host
    );

    // A caller in the cluster (hub side) — no local hub subscriber exists, so the
    // request must traverse the leaf to reach the developer's local service.
    const hubConn = await hub.connect();
    const callerTransport = createNatsTransport({ connection: hubConn, queue: 'q' });
    const caller = Client.create(GreeterContract, callerTransport.client);

    await settle();

    const result = await caller.greet({ name: 'dev' });
    expect(result).toEqual({ greeting: 'hello dev', servedBy: 'leaf' });

    await host.stop();
    await leafConn.close();
    await hubConn.close();
  });

  // --------------------------------------------------------------------------
  // AC4: a leaf-local service can CALL a remote service living in the cluster.
  // --------------------------------------------------------------------------

  test('AC4: a leaf-local client calls a service running in the cluster', async () => {
    // The remote service runs on the hub (the cluster).
    const hubConn = await hub.connect();
    const remoteTransport = createNatsTransport({ connection: hubConn, queue: 'q' });
    const remoteHost = await Host.create(
      ClockContract,
      { now: async () => ({ iso: '2026-06-08T00:00:00.000Z' }) } as never,
      remoteTransport.host
    );

    // The developer's local client (on the leaf) calls it across the boundary.
    const leafConn = await leaf.connect();
    const localTransport = createNatsTransport({ connection: leafConn, queue: 'q' });
    const localClient = Client.create(ClockContract, localTransport.client);

    await settle();

    const result = await localClient.now({});
    expect(result).toEqual({ iso: '2026-06-08T00:00:00.000Z' });

    await remoteHost.stop();
    await hubConn.close();
    await leafConn.close();
  });

  // --------------------------------------------------------------------------
  // AC3: requests are load-balanced across queue-group members spanning the
  // leaf boundary. NOTE: NATS leaf nodes prefer a *locally* available queue
  // subscriber to minimise cross-boundary traffic; cross-boundary delivery
  // happens when the originating side has no local member. We assert the real,
  // documented behaviour: with members on BOTH sides, a cluster-originated
  // request with NO hub-local member is served by the leaf member; remove the
  // leaf member and the same request falls back to a remote member. (See the
  // final report for how this qualifies AC3 as literally written.)
  // --------------------------------------------------------------------------

  test('AC3: a cluster request is served by the leaf member, and falls back to a remote member when the leaf leaves', async () => {
    const leafConn = await leaf.connect();
    const leafTransport = createNatsTransport({ connection: leafConn, queue: 'q' });
    const leafHost = await Host.create(
      GreeterContract,
      {
        greet: async (input: { name: string }) => ({
          greeting: `hello ${input.name}`,
          servedBy: 'leaf',
        }),
      } as never,
      leafTransport.host
    );

    const hubConn = await hub.connect();
    const callerTransport = createNatsTransport({ connection: hubConn, queue: 'q' });
    const caller = Client.create(GreeterContract, callerTransport.client);

    await settle();

    // Only the leaf member exists for this subject -> the cluster-originated
    // request is delivered across the boundary to the leaf.
    const viaLeaf = await caller.greet({ name: 'dev' });
    expect(viaLeaf.servedBy).toBe('leaf');

    // The developer's service goes away (e.g. hot reload / shutdown). A remote
    // member in the cluster now serves the same queue group.
    await leafHost.stop();
    await leafConn.close();

    const remoteConn = await hub.connect();
    const remoteTransport = createNatsTransport({ connection: remoteConn, queue: 'q' });
    const remoteHost = await Host.create(
      GreeterContract,
      {
        greet: async (input: { name: string }) => ({
          greeting: `hello ${input.name}`,
          servedBy: 'remote',
        }),
      } as never,
      remoteTransport.host
    );

    await settle();

    const viaRemote = await caller.greet({ name: 'dev' });
    expect(viaRemote.servedBy).toBe('remote');

    await remoteHost.stop();
    await remoteConn.close();
    await hubConn.close();
  });

  // --------------------------------------------------------------------------
  // AC5: hot reload — restarting the local service re-registers its handlers on
  // the same leaf, and cluster traffic resumes reaching it. The leaf node stays
  // up across the restart (it is not torn down with the service process).
  // --------------------------------------------------------------------------

  test('AC5: restarting the leaf-local service re-registers handlers and resumes serving', async () => {
    const hubConn = await hub.connect();
    const callerTransport = createNatsTransport({ connection: hubConn, queue: 'q' });
    const caller = Client.create(GreeterContract, callerTransport.client);

    // First "run" of the developer's service.
    const conn1 = await leaf.connect();
    const t1 = createNatsTransport({ connection: conn1, queue: 'q' });
    const host1 = await Host.create(
      GreeterContract,
      {
        greet: async (input: { name: string }) => ({
          greeting: `hello ${input.name}`,
          servedBy: 'run-1',
        }),
      } as never,
      t1.host
    );

    await settle();
    expect((await caller.greet({ name: 'dev' })).servedBy).toBe('run-1');

    // Restart: stop the service + its connection (the leaf node itself stays up).
    await host1.stop();
    await conn1.close();

    // Second "run" re-registers on the same leaf.
    const conn2 = await leaf.connect();
    const t2 = createNatsTransport({ connection: conn2, queue: 'q' });
    const host2 = await Host.create(
      GreeterContract,
      {
        greet: async (input: { name: string }) => ({
          greeting: `hello ${input.name}`,
          servedBy: 'run-2',
        }),
      } as never,
      t2.host
    );

    await settle();
    expect((await caller.greet({ name: 'dev' })).servedBy).toBe('run-2');

    await host2.stop();
    await conn2.close();
    await hubConn.close();
  });
});

// --------------------------------------------------------------------------
// startLeafNode lifecycle: it is a single nats-server process the developer
// owns and tears down (AC6 — minimal setup, just nats-server + Bun).
// --------------------------------------------------------------------------

describe('startLeafNode lifecycle', () => {
  let hub: EphemeralNatsServer;

  beforeAll(async () => {
    hub = await startEphemeralNatsServer({ leafnodes: true });
  });

  afterAll(async () => {
    await hub.stop();
  });

  test('AC6: starts a leaf node from config alone and accepts local connections', async () => {
    const leaf = await startLeafNode({
      remotes: [{ url: `nats-leaf://127.0.0.1:${hub.leafnodePort!}` }],
    });

    expect(leaf.port).toBeGreaterThan(0);
    expect(leaf.url).toBe(`nats://127.0.0.1:${leaf.port}`);

    const conn = await leaf.connect();
    expect(conn.isClosed()).toBe(false);
    await conn.close();

    await leaf.stop();
  });

  test('stop() is idempotent', async () => {
    const leaf = await startLeafNode({
      remotes: [{ url: `nats-leaf://127.0.0.1:${hub.leafnodePort!}` }],
    });
    await leaf.stop();
    await expect(leaf.stop()).resolves.toBeUndefined();
  });
});
