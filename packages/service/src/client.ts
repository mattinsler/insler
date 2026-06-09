import { Client } from '@insler/rpc-client';
import type {
  ClientMiddleware,
  ClientOptions,
  ClientTransport,
  ResultClientOptions,
  ThrowClientOptions,
} from '@insler/rpc-client';
import { loggingMiddleware, timingMiddleware } from '@insler/rpc-client/dev';
import type { Contract, ContractDef } from '@insler/rpc-contract';

import { detectEnv } from './env.js';
import type { ServiceEnv } from './env.js';

export type { ServiceEnv } from './env.js';

type ContractClient<C extends ContractDef> = Contract.Client<C>;
type ContractResultClient<C extends ContractDef> = Contract.ResultClient<C>;

export interface ServiceClientOptions {
  middleware?: ClientMiddleware[];
  errors?: 'throw' | 'result';
  env?: ServiceEnv;
}

function buildClientMiddleware(
  env: ServiceEnv,
  userMiddleware: ClientMiddleware[] | undefined
): ClientMiddleware[] {
  const stack: ClientMiddleware[] = [];

  if (env === 'development') {
    stack.push(loggingMiddleware());
    stack.push(timingMiddleware());
  }

  if (userMiddleware) {
    stack.push(...userMiddleware);
  }

  return stack;
}

export namespace ServiceClient {
  export function create<C extends ContractDef>(
    contract: C,
    transport: ClientTransport,
    options: ServiceClientOptions & { errors: 'result' }
  ): ContractResultClient<C>;
  export function create<C extends ContractDef>(
    contract: C,
    transport: ClientTransport,
    options?: ServiceClientOptions
  ): ContractClient<C>;
  export function create<C extends ContractDef>(
    contract: C,
    transport: ClientTransport,
    options?: ServiceClientOptions
  ): ContractClient<C> | ContractResultClient<C> {
    const env = options?.env ?? detectEnv();
    const middleware = buildClientMiddleware(env, options?.middleware);
    const errorStrategy = options?.errors ?? 'throw';

    const clientOptions: ClientOptions = {
      middleware: middleware.length > 0 ? middleware : undefined,
      errors: errorStrategy,
    } as ClientOptions;

    if (errorStrategy === 'result') {
      return Client.create(contract, transport, clientOptions as ResultClientOptions);
    }
    return Client.create(contract, transport, clientOptions as ThrowClientOptions);
  }

  export function withContext<C extends ContractDef>(
    client: ContractResultClient<C>,
    context: Record<string, unknown>
  ): Contract.ResultScopedClient<C>;
  export function withContext<C extends ContractDef>(
    client: ContractClient<C>,
    context: Record<string, unknown>
  ): Contract.ScopedClient<C>;
  export function withContext<C extends ContractDef>(
    client: ContractClient<C> | ContractResultClient<C>,
    context: Record<string, unknown>
  ): Contract.ScopedClient<C> | Contract.ResultScopedClient<C> {
    return Client.withContext(client as any, context) as any;
  }
}
