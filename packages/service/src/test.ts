import { Client } from '@insler/rpc-client';
import type { Contract, ContractDef } from '@insler/rpc-contract';
import { Host } from '@insler/rpc-host';
import type { HostInstance } from '@insler/rpc-host';
import { validateHandlers } from '@insler/rpc-host/dev';
import { createMemoryTransport } from '@insler/rpc-transport-memory';

export interface ServiceTestPair<C extends ContractDef> {
  client: Contract.Client<C>;
  host: HostInstance;
  stop(): Promise<void>;
}

export interface ServiceTestResultPair<C extends ContractDef> {
  client: Contract.ResultClient<C>;
  host: HostInstance;
  stop(): Promise<void>;
}

export namespace ServiceTest {
  export async function pair<C extends ContractDef>(
    contract: C,
    handlers: Contract.Handlers<C>
  ): Promise<ServiceTestPair<C>> {
    const missing = validateHandlers(contract, handlers as Record<string, unknown>);
    if (missing.length > 0) {
      throw new Error(`Missing handlers for contract '${contract.kind}': ${missing.join(', ')}`);
    }

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

  export async function resultPair<C extends ContractDef>(
    contract: C,
    handlers: Contract.Handlers<C>
  ): Promise<ServiceTestResultPair<C>> {
    const missing = validateHandlers(contract, handlers as Record<string, unknown>);
    if (missing.length > 0) {
      throw new Error(`Missing handlers for contract '${contract.kind}': ${missing.join(', ')}`);
    }

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
