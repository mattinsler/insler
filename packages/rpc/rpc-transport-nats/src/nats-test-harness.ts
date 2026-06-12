import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect, type NatsConnection } from '@nats-io/transport-node';

/**
 * Ephemeral `nats-server` harness for `@insler/rpc-transport-nats` integration tests.
 *
 * Spawns a real, throwaway core-NATS server (NO JetStream) on loopback with a
 * random port, then tears it down deterministically. This is the foundation the
 * streaming and discovery integration tests build on so they exercise real wire
 * behavior (timing, credit flow, `nats` CLI interop) rather than only the
 * in-memory mock.
 *
 * Binary provisioning: the `nats-server` binary is provisioned via **mise** — it
 * is pinned in the project `mise.toml [tools]` (nats-server 2.14.0) and resolves
 * through the environment/PATH (mise shims). We do NOT vendor an npm package that
 * bundles a binary and we do NOT add a CI download step. `nats-server` must be on
 * PATH (it is, via mise) for these tests to run.
 *
 * Design constraints (validated against the NATS + Bun docs):
 * - Launch with `-a 127.0.0.1 -p -1`: loopback only, random port via `-1`.
 * - NO `-js` / `--mem_storage` / `--client_advertise`. Core NATS holds nothing on
 *   disk; JetStream would only add the disk I/O we want to avoid.
 * - Resolve the actual port deterministically by reading the JSON ports file NATS
 *   writes into `--ports_file_dir` — never sleep-and-scrape stdout.
 * - Explicit teardown: `proc.kill(); await proc.exited`. Bun does NOT auto-kill
 *   child processes on exit (the parent waits on them), so relying on automatic
 *   cleanup would hang the runner and leak servers.
 */

const NATS_SERVER_BIN = 'nats-server';

/**
 * A running ephemeral `nats-server`. Always call {@link EphemeralNatsServer.stop}
 * in test teardown (`afterAll`/`afterEach`).
 */
export interface EphemeralNatsServer {
  /** Connection URL of the running server, e.g. `nats://127.0.0.1:54321`. */
  readonly url: string;
  /** The resolved (random) port the server bound to. */
  readonly port: number;
  /**
   * The resolved (random) leafnode-listener port, when the server was started
   * with `{ leafnodes: true }`. A dev leaf node solicits a route to this port
   * (see {@link startEphemeralNatsServer} options and `leaf-node.ts`).
   * `undefined` when the leafnode listener was not enabled.
   */
  readonly leafnodePort?: number;
  /**
   * Open a fresh NATS connection to this server. The caller owns the returned
   * connection's lifecycle and should `await connection.close()` (or rely on
   * {@link stop}, which closes any connections it created via {@link connect}).
   */
  connect(): Promise<NatsConnection>;
  /**
   * Kill the server and await its exit, close any connections opened via
   * {@link connect}, and remove the temp ports-file dir. Idempotent.
   */
  stop(): Promise<void>;
}

/**
 * Read the JSON ports file NATS writes into `dir` and return the bound port.
 *
 * NATS writes `nats-server_<pid>.ports` containing
 * `{"nats":["nats://host:port", ...]}`. We poll for the file (it appears once the
 * listener is bound) rather than sleeping a fixed interval — this is the
 * deterministic, no-sleep-scrape resolution the issue requires.
 *
 * Exported because `leaf-node.ts`'s `startLeafNode` reuses the exact same
 * ports-file resolution for the leaf server's client port — the resolution is a
 * harness primitive, not a private of `startEphemeralNatsServer`.
 */
export async function resolvePortFromPortsFile(dir: string, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;

  while (Date.now() < deadline) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      lastErr = err;
      entries = [];
    }

    const portsFile = entries.find((name) => name.endsWith('.ports'));
    if (portsFile) {
      try {
        const raw = await readFile(join(dir, portsFile), 'utf8');
        const parsed = JSON.parse(raw) as { nats?: string[] };
        const endpoint = parsed.nats?.[0];
        if (endpoint) {
          const port = Number(new URL(endpoint).port);
          if (Number.isInteger(port) && port > 0) {
            return port;
          }
        }
      } catch (err) {
        // File may be mid-write; retry until the deadline.
        lastErr = err;
      }
    }

    // Yield briefly between polls; this is a readiness poll, not a fixed sleep —
    // we proceed the instant the ports file is parseable.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(
    `Timed out resolving nats-server port from ports file in ${dir}` +
      (lastErr instanceof Error ? `: ${lastErr.message}` : '')
  );
}

/**
 * Read-and-discard a stream to completion in the background, so a child process
 * whose pipe nobody consumes can never fill the pipe buffer and stall under
 * verbose logging.
 */
function drainInBackground(stream: ReadableStream<Uint8Array>): void {
  void (async () => {
    const reader = stream.getReader();
    try {
      while (!(await reader.read()).done) {
        // discard
      }
    } catch {
      // The process exited / the stream errored — nothing left to drain.
    } finally {
      reader.releaseLock();
    }
  })();
}

/**
 * Resolve the leafnode-listener port from the server's stderr.
 *
 * The leafnode port is NOT written to the ports file in nats-server 2.14.0 (only
 * the client `nats` endpoint is — version-coupled: revisit if the pinned server
 * changes), so we read it from the line the server logs the
 * instant the listener binds:
 *
 *   [INF] Listening for leafnode connections on 127.0.0.1:62960
 *
 * This is a readiness poll on the log stream, not a fixed sleep: we resolve the
 * moment the line appears and never scrape on a timer.
 */
async function resolveLeafnodePortFromLog(
  stream: ReadableStream<Uint8Array>,
  timeoutMs = 10_000
): Promise<number> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffered = '';
  const deadline = Date.now() + timeoutMs;
  const re = /Listening for leafnode connections on \S+:(\d+)/;

  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      const match = re.exec(buffered);
      if (match?.[1]) {
        return Number(match[1]);
      }
    }
  } finally {
    reader.releaseLock();
  }

  throw new Error('Timed out resolving nats-server leafnode port from server log');
}

/**
 * Start an ephemeral core-NATS server on loopback with a random port and return a
 * handle. Call {@link EphemeralNatsServer.stop} in teardown.
 *
 * Pass `{ leafnodes: true }` to additionally open a leafnode listener on a random
 * port (resolved into {@link EphemeralNatsServer.leafnodePort}). A dev leaf node
 * (see `leaf-node.ts`) solicits a route to that port to join this server's mesh —
 * the topology the development inner loop is built on (hub = shared dev cluster,
 * leaf = the developer's machine).
 */
export async function startEphemeralNatsServer(
  options: { leafnodes?: boolean } = {}
): Promise<EphemeralNatsServer> {
  const portsDir = await mkdtemp(join(tmpdir(), 'insler-nats-'));

  // Core NATS only: loopback (-a 127.0.0.1), random port (-p -1), ports file for
  // deterministic port resolution. No -js / --mem_storage / --client_advertise.
  // When leafnodes are requested, add a config file opening a random-port leafnode
  // listener on loopback (the flag form does not exist; it is config-only).
  const args = [NATS_SERVER_BIN, '-a', '127.0.0.1', '-p', '-1', '--ports_file_dir', portsDir];
  let configPath: string | undefined;
  if (options.leafnodes) {
    configPath = join(portsDir, 'leaf-hub.conf');
    await Bun.write(configPath, 'leafnodes {\n  host: "127.0.0.1"\n  port: -1\n}\n');
    args.push('-c', configPath);
  }

  // Nothing reads stdout, and stderr only matters while scraping the leafnode
  // port — an unread 'pipe' would let a verbose server fill the buffer and stall.
  const proc = Bun.spawn(args, {
    stdout: 'ignore',
    stderr: options.leafnodes ? 'pipe' : 'ignore',
  });

  const openConnections = new Set<NatsConnection>();
  let stopped = false;

  const cleanup = async (): Promise<void> => {
    await rm(portsDir, { recursive: true, force: true }).catch(() => {});
  };

  let port: number;
  let leafnodePort: number | undefined;
  try {
    port = await resolvePortFromPortsFile(portsDir);
    if (options.leafnodes) {
      const stderr = proc.stderr as ReadableStream<Uint8Array>;
      leafnodePort = await resolveLeafnodePortFromLog(stderr);
      // Keep consuming stderr for the server's lifetime so it can't block.
      drainInBackground(stderr);
    }
  } catch (err) {
    // Failed to come up — kill and await so we never leak a server.
    proc.kill();
    await proc.exited;
    await cleanup();
    throw err;
  }

  const url = `nats://127.0.0.1:${port}`;

  return {
    url,
    port,
    leafnodePort,
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

      // Explicit teardown — Bun does not auto-kill children.
      proc.kill();
      await proc.exited;

      await cleanup();
    },
  };
}
