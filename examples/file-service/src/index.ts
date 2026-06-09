import { container } from '@insler/di';
import { Client } from '@insler/rpc-client';
import { createNatsTransport } from '@insler/rpc-transport-nats';
import { msgpackSerde } from '@insler/serde-msgpack';
import { Service } from '@insler/service';
import { connect } from '@nats-io/transport-node';

import type { Identity } from './contract.js';
import { fileServiceContract } from './contract.js';
import { fileServiceModule, fileServiceToken } from './token.js';

const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222';

async function main(): Promise<void> {
  // 1. Resolve the handlers from DI. The container owns wiring; the service
  //    host just takes the contract-shaped handlers it produces.
  const di = await container().use(fileServiceModule()).start();
  const handlers = di.get(fileServiceToken);

  // 2. Connect to NATS and build a transport pair that serializes with msgpack.
  //    The serde is the wire format both sides share; swap msgpackSerde for
  //    jsonBytesSerde/cborSerde/avroSerde without touching anything else.
  const connection = await connect({ servers: NATS_URL });
  const transport = createNatsTransport({ connection, serde: msgpackSerde });

  const host = await Service.create(fileServiceContract, handlers, transport.host);

  console.log(
    `▶ ${fileServiceContract.kind}@${fileServiceContract.version} is up (NATS ${NATS_URL}, msgpack)`
  );

  // 3. Prove the round-trip on boot with a client scoped to a caller identity.
  //    The identity is contract context, so it is applied once via withContext
  //    and then every call carries it transparently.
  const identity: Identity = { userId: 'u_42', orgId: 'acme' };
  const client = Client.withContext(Client.create(fileServiceContract, transport.client), {
    identity,
  });

  const written = await client.writeFile({
    path: 'notes/hello.txt',
    content: 'hello, world',
    contentType: 'text/plain',
  });
  console.log(`wrote  ${written.path} (${written.size}b, etag ${written.etag})`);

  const read = await client.readFile({ path: 'notes/hello.txt' });
  console.log(`read   ${read.path}: "${read.content}"`);

  await client.writeFile({ path: 'notes/todo.md', content: '- ship the example' });
  const { files } = await client.listFiles({ prefix: 'notes/' });
  console.log(`list   notes/: ${files.map((f) => f.path).join(', ')}`);

  // Server streaming over NATS is a first-class call (framework issue 0005): the
  // contract declares watchFiles as a serverStream, so the client method returns
  // an async iterable and each yielded entry rides a DataFrame across the wire —
  // observably identical to the memory transport.
  console.log('watch  notes/ (server stream):');
  for await (const info of client.watchFiles({ prefix: 'notes/' })) {
    console.log(`  • ${info.path} ${info.size}b`);
  }

  // 4. Show typed error handling: reading a missing file throws a ContractError
  //    tagged exactly as the contract declares.
  try {
    await client.readFile({ path: 'notes/missing.txt' });
  } catch (error) {
    console.log(`error  ${(error as { _tag?: string })._tag ?? 'unknown'} for notes/missing.txt`);
  }

  // 5. Stay up until interrupted, then shut the host and container down cleanly
  //    (the container stops bindings in reverse order) and drain the connection.
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n⏹ ${signal} received — shutting down`);
    await host.stop();
    await di.stop();
    await connection.drain();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  console.log('\nPress Ctrl+C to stop.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
