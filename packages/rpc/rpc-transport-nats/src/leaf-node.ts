import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, type NatsConnection } from '@nats-io/transport-node';

import { resolvePortFromPortsFile } from './nats-test-harness.js';

/**
 * NATS leaf node configuration for the **development inner loop** (ifc-platform
 * issue 0025).
 *
 * A developer runs one or two `@insler` services locally on Bun and joins them to
 * a shared development NATS cluster through a **leaf node** running on their
 * machine. The leaf node solicits a route to the cluster's leafnode listener; once
 * connected, the developer's local services participate in the real mesh —
 * publishing on, subscribing to, and queue-grouping against the same subjects as
 * the remote fleet — WITHOUT the developer running the whole fleet locally.
 *
 * This module owns the *leaf node configuration and lifecycle*. It does NOT own the
 * `insler dev up` CLI ergonomics or fetching dev-cluster credentials from a secrets
 * backend — those are platform (CLI) concerns layered on top. What lives here is the
 * transport-anchored slice the rest of that experience compiles down to: given a
 * dev-cluster endpoint (and optionally a credentials file the tool resolved), build
 * the leaf-node server configuration and run it.
 *
 * Core NATS only — no JetStream — matching the rest of `@insler/rpc-transport-nats`.
 */

/**
 * A single dev-cluster endpoint a leaf node solicits a route to. `url` is the
 * cluster's **leafnode** listener (the `nats-leaf://` scheme, distinct from the
 * `nats://` client port). `credentials`, when present, is an absolute path to a
 * NATS `.creds` file the tool resolved for this leaf — this is how "credentials for
 * the dev cluster connection are managed by the tool" is threaded into the wire
 * config without a service ever embedding a secret.
 */
export interface LeafNodeRemote {
  /** Dev-cluster leafnode listener URL, e.g. `nats-leaf://dev-cluster:7422`. */
  readonly url: string;
  /** Absolute path to a `.creds` file authorizing this leaf to the cluster. */
  readonly credentials?: string;
  /** Bind this remote to a specific account on the leaf, if accounts are in use. */
  readonly account?: string;
}

/**
 * The inputs needed to bring up a developer's local leaf node. `remotes` are the
 * dev-cluster endpoints to solicit; `host`/`port` govern the leaf's *local* client
 * listener that the developer's services connect to (defaults: loopback, random
 * port). No Docker and no Kubernetes — a leaf node is a single `nats-server`
 * process plus Bun.
 */
export interface LeafNodeConfig {
  readonly remotes: readonly LeafNodeRemote[];
  /** Local client-listener host. Defaults to `127.0.0.1` (loopback). */
  readonly host?: string;
  /** Local client-listener port. Defaults to `-1` (a random ephemeral port). */
  readonly port?: number;
}

/** The shape of the `leafnodes.remotes[]` entries in a nats-server config object. */
interface LeafNodeRemoteConfig {
  readonly url: string;
  readonly credentials?: string;
  readonly account?: string;
}

/** A nats-server configuration object that runs the process as a leaf node. */
export interface LeafNodeServerConfig {
  readonly host: string;
  readonly port: number;
  readonly leafnodes: {
    readonly remotes: readonly LeafNodeRemoteConfig[];
  };
}

/**
 * Build the nats-server configuration object that runs the local process as a leaf
 * node joined to the given dev-cluster `remotes`. Pure: no I/O, no process — just
 * the desired config. Credentials are threaded through verbatim onto each remote.
 *
 * Throws if `remotes` is empty: a leaf node with nothing to solicit is a
 * misconfiguration (it would never join the dev cluster), and surfacing it here is
 * far better than a silently isolated leaf.
 */
export function buildLeafNodeServerConfig(config: LeafNodeConfig): LeafNodeServerConfig {
  if (config.remotes.length === 0) {
    throw new Error('Leaf node requires at least one dev-cluster remote to solicit a route to');
  }

  return {
    host: config.host ?? '127.0.0.1',
    port: config.port ?? -1,
    leafnodes: {
      remotes: config.remotes.map((remote) => {
        const entry: { url: string; credentials?: string; account?: string } = { url: remote.url };
        if (remote.credentials !== undefined) {
          entry.credentials = remote.credentials;
        }
        if (remote.account !== undefined) {
          entry.account = remote.account;
        }
        return entry;
      }),
    },
  };
}

/**
 * Render a {@link LeafNodeServerConfig} to nats-server config-file text.
 *
 * nats-server's config format is a JSON superset, so a compact JSON encoding is a
 * valid config file the server parses directly — no bespoke serializer to drift
 * from the real grammar.
 */
export function renderLeafNodeServerConfig(config: LeafNodeServerConfig): string {
  return JSON.stringify(config, null, 2);
}

/**
 * A running developer leaf node. Mirrors the ephemeral-server handle: the developer
 * connects local services to {@link LeafNode.url} and tears the node down with
 * {@link LeafNode.stop} (idempotent).
 */
export interface LeafNode {
  /** Local client URL the developer's services connect to, e.g. `nats://127.0.0.1:54321`. */
  readonly url: string;
  /** The resolved local client port. */
  readonly port: number;
  /** Open a fresh connection to the leaf's local client listener. */
  connect(): Promise<NatsConnection>;
  /** Kill the leaf-node process, close connections it opened, and clean up. Idempotent. */
  stop(): Promise<void>;
}

const NATS_SERVER_BIN = 'nats-server';

/**
 * Start a developer leaf node: spawn a `nats-server` configured to solicit routes
 * to the dev cluster's leafnode listener(s), resolve its local client port, and
 * return a handle. This is the programmatic core the `insler dev up` command wraps
 * — "one process to start developing", joined to the shared cluster.
 *
 * Hot reload is a property of the developer's *service* process, not the leaf node:
 * the leaf stays up across `bun --hot` restarts, and a restarted service simply
 * re-subscribes its queue-group subjects on the same leaf connection.
 */
export async function startLeafNode(config: LeafNodeConfig): Promise<LeafNode> {
  const serverConfig = buildLeafNodeServerConfig(config);
  const workDir = await mkdtemp(join(tmpdir(), 'insler-leaf-'));
  const configPath = join(workDir, 'leaf.conf');
  await Bun.write(configPath, renderLeafNodeServerConfig(serverConfig));

  // The port comes from the ports file, so nothing ever reads these streams —
  // an unread 'pipe' could fill and stall the server under verbose logging.
  const proc = Bun.spawn([NATS_SERVER_BIN, '-c', configPath, '--ports_file_dir', workDir], {
    stdout: 'ignore',
    stderr: 'ignore',
  });

  const openConnections = new Set<NatsConnection>();
  let stopped = false;

  const cleanup = async (): Promise<void> => {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  };

  let port: number;
  try {
    port = await resolvePortFromPortsFile(workDir);
  } catch (err) {
    proc.kill();
    await proc.exited;
    await cleanup();
    throw err;
  }

  const url = `nats://127.0.0.1:${port}`;

  return {
    url,
    port,
    async connect(): Promise<NatsConnection> {
      const connection = await connect({ servers: url });
      openConnections.add(connection);
      void connection.closed().then(() => openConnections.delete(connection));
      return connection;
    },
    async stop(): Promise<void> {
      if (stopped) {
        return;
      }
      stopped = true;

      for (const connection of openConnections) {
        await connection.close().catch(() => {});
      }
      openConnections.clear();

      proc.kill();
      await proc.exited;

      await cleanup();
    },
  };
}
