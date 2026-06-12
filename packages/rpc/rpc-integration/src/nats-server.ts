import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Ephemeral `nats-server` lifecycle for the rpc integration suite.
 *
 * The binary comes from the repo's **mise toolchain** (`mise.toml` pins
 * nats-server; mise puts it on PATH locally and in CI) — exactly the real
 * infrastructure an external consumer would run against. The suite owns the
 * lifecycle: start in `beforeAll`, stop in `afterAll`.
 *
 * This is deliberately the integration package's own glue, not an import from
 * `@insler/rpc-transport-nats` internals: the adapter's test harness is not
 * part of its published surface, and this package imports public surfaces
 * only. Mechanics follow the same validated design (loopback, random port via
 * `-p -1`, deterministic port resolution from the `--ports_file_dir` JSON
 * file, explicit kill-and-await teardown — Bun never auto-kills children).
 */
export interface EphemeralNatsServer {
  /** Connection URL of the running server, e.g. `nats://127.0.0.1:54321`. */
  readonly url: string;
  /** Kill the server, await its exit, and remove the temp ports dir. Idempotent. */
  stop(): Promise<void>;
}

async function resolvePortFromPortsFile(dir: string, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const entries = await readdir(dir).catch(() => [] as string[]);
    const portsFile = entries.find((name) => name.endsWith('.ports'));
    if (portsFile) {
      try {
        const parsed = JSON.parse(await readFile(join(dir, portsFile), 'utf8')) as {
          nats?: string[];
        };
        const endpoint = parsed.nats?.[0];
        if (endpoint) {
          const port = Number(new URL(endpoint).port);
          if (Number.isInteger(port) && port > 0) return port;
        }
      } catch {
        // File may be mid-write; retry until the deadline.
      }
    }
    // Readiness poll, not a fixed sleep: proceed the instant the file parses.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out resolving nats-server port from ports file in ${dir}`);
}

/** Start a throwaway core-NATS server on loopback with a random port. */
export async function startNatsServer(): Promise<EphemeralNatsServer> {
  const portsDir = await mkdtemp(join(tmpdir(), 'insler-rpc-integration-'));
  const proc = Bun.spawn(
    ['nats-server', '-a', '127.0.0.1', '-p', '-1', '--ports_file_dir', portsDir],
    { stdout: 'ignore', stderr: 'ignore' }
  );

  let port: number;
  try {
    port = await resolvePortFromPortsFile(portsDir);
  } catch (err) {
    proc.kill();
    await proc.exited;
    await rm(portsDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  let stopped = false;
  return {
    url: `nats://127.0.0.1:${port}`,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      proc.kill();
      await proc.exited;
      await rm(portsDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
