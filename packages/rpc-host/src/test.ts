import { Client } from '@insler/rpc-client';
import type { Contract, ContractDef } from '@insler/rpc-contract';
import { createMemoryTransport } from '@insler/rpc-transport-memory';

import { Host } from './host.js';
import type { HostInstance } from './host.js';

/**
 * Test utilities for creating in-process host+client pairs.
 */
export namespace TestHost {
  /**
   * A host+client pair for testing with throw-mode errors.
   */
  export interface Pair<C extends ContractDef> {
    client: Contract.Client<C>;
    host: HostInstance;
    stop(): Promise<void>;
  }

  /**
   * A host+client pair for testing with result-mode errors.
   */
  export interface ResultPair<C extends ContractDef> {
    client: Contract.ResultClient<C>;
    host: HostInstance;
    stop(): Promise<void>;
  }

  /**
   * Create an in-process host+client pair with zero configuration.
   * Uses `@insler/rpc-transport-memory` internally.
   *
   * @example
   * ```ts
   * const { client, stop } = await TestHost.pair(MyContract, myHandlers);
   * const result = await client.someMethod(input);
   * await stop();
   * ```
   */
  export async function pair<C extends ContractDef>(
    contract: C,
    handlers: Contract.Handlers<C>
  ): Promise<Pair<C>> {
    const transport = createMemoryTransport();
    const host = await Host.create(
      contract,
      handlers as Record<string, (...args: unknown[]) => unknown>,
      transport.host
    );
    const client = Client.create(contract, transport.client);

    return {
      client,
      host,
      stop: () => host.stop(),
    };
  }

  /**
   * Create an in-process host+client pair with result-mode errors.
   * The client returns `{ ok: true, value }` or `{ ok: false, error }` instead of throwing.
   */
  export async function resultPair<C extends ContractDef>(
    contract: C,
    handlers: Contract.Handlers<C>
  ): Promise<ResultPair<C>> {
    const transport = createMemoryTransport();
    const host = await Host.create(
      contract,
      handlers as Record<string, (...args: unknown[]) => unknown>,
      transport.host
    );
    const client = Client.create(contract, transport.client, { errors: 'result' });

    return {
      client,
      host,
      stop: () => host.stop(),
    };
  }
}
