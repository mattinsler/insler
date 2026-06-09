import type { Propagator } from '@insler/rpc-context';
import { createPropagator } from '@insler/rpc-context';
import type { Contract, ContractDef, MethodDef } from '@insler/rpc-contract';

type ContractClient<C extends ContractDef> = Contract.Client<C>;
type ContractScopedClient<C extends ContractDef> = Contract.ScopedClient<C>;
type ContractResultClient<C extends ContractDef> = Contract.ResultClient<C>;
type ContractResultScopedClient<C extends ContractDef> = Contract.ResultScopedClient<C>;

import { ContractError } from './error.js';
import type { ClientNext, ClientStreamMiddleware } from './middleware.js';
import { composeMiddleware } from './middleware.js';
import type { ClientRequest, ClientResponse, ClientTransport } from './transport.js';

const DEFAULT_PROPAGATOR = createPropagator({
  encode: (value) => JSON.stringify(value),
  decode: (wire) => JSON.parse(wire),
});

// -- Options --

export interface ThrowClientOptions {
  readonly middleware?: ClientStreamMiddleware[];
  readonly errors?: 'throw';
  readonly propagator?: Propagator;
}

export interface ResultClientOptions {
  readonly middleware?: ClientStreamMiddleware[];
  readonly errors: 'result';
  readonly propagator?: Propagator;
}

export type ClientOptions = ThrowClientOptions | ResultClientOptions;

// -- Internal helpers --

function hasContext(contract: ContractDef, method: MethodDef): boolean {
  const ctx = method.context !== undefined ? method.context : contract.context;
  return Object.keys(ctx).length > 0;
}

function isVoidInput(method: MethodDef): boolean {
  const schema = method.input as any;
  if (schema?._zod?.def?.type === 'void') return true;
  if (schema?._def?.typeName === 'ZodVoid') return true;
  return false;
}

function serializeContext(
  context: Record<string, unknown>,
  propagator: Propagator
): Record<string, string> {
  const metadata: Record<string, string> = {};
  propagator.inject(context, metadata);
  return metadata;
}

function processResponse(response: ClientResponse, errorStrategy: 'throw' | 'result'): unknown {
  if (response.error) {
    if (errorStrategy === 'throw') {
      throw new ContractError(response.error._tag, response.error.payload, response.error.message);
    }
    return {
      ok: false,
      error: { _tag: response.error._tag, payload: response.error.payload },
    };
  }

  if (errorStrategy === 'result') {
    return { ok: true, value: response.output };
  }

  return response.output;
}

function parseUnaryArgs(
  contract: ContractDef,
  method: MethodDef,
  args: unknown[],
  contextOverride?: Record<string, unknown>
): { context?: Record<string, unknown>; input: unknown } {
  const methodHasContext = hasContext(contract, method);
  const methodIsVoid = isVoidInput(method);

  if (contextOverride) {
    return { context: contextOverride, input: methodIsVoid ? undefined : args[0] };
  }
  if (methodHasContext) {
    return {
      context: args[0] as Record<string, unknown>,
      input: methodIsVoid ? undefined : args[1],
    };
  }
  return { input: methodIsVoid ? undefined : args[0] };
}

function parseStreamArgs(
  contract: ContractDef,
  method: MethodDef,
  args: unknown[],
  contextOverride?: Record<string, unknown>
): { context?: Record<string, unknown>; inputStream: AsyncIterable<unknown> } {
  const methodHasContext = hasContext(contract, method);

  if (contextOverride) {
    return { context: contextOverride, inputStream: args[0] as AsyncIterable<unknown> };
  }
  if (methodHasContext) {
    return {
      context: args[0] as Record<string, unknown>,
      inputStream: args[1] as AsyncIterable<unknown>,
    };
  }
  return { inputStream: args[0] as AsyncIterable<unknown> };
}

function makeRequest(
  contract: ContractDef,
  method: MethodDef,
  context: Record<string, unknown> | undefined,
  propagator: Propagator,
  input?: unknown
): ClientRequest {
  return {
    service: contract.kind,
    method: method.name,
    kind: method.kind,
    input,
    metadata: context ? serializeContext(context, propagator) : undefined,
  };
}

async function* mapResponseStream(stream: AsyncIterable<ClientResponse>): AsyncIterable<unknown> {
  for await (const response of stream) {
    if (response.error) {
      throw new ContractError(response.error._tag, response.error.payload, response.error.message);
    }
    yield response.output;
  }
}

function isResponseStream(value: unknown): value is AsyncIterable<ClientResponse> {
  return (
    value != null &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  );
}

/**
 * Normalize a dispatch result into a response stream. A `serverStream` call normally produces a
 * stream of responses, but a middleware that short-circuits (returns without calling `next`)
 * yields a single terminal response instead. Either way the caller observes an async-iterable, so
 * the short-circuit surfaces through the same error channel as the stream (no new error channel).
 */
async function* toResponseStream(
  result: Promise<ClientResponse> | AsyncIterable<ClientResponse> | ClientResponse
): AsyncIterable<ClientResponse> {
  const resolved = await result;
  if (isResponseStream(resolved)) {
    yield* resolved;
  } else {
    yield resolved;
  }
}

// -- Method builders --

function buildUnaryMethod(
  contract: ContractDef,
  method: MethodDef,
  dispatch: ClientNext,
  errorStrategy: 'throw' | 'result',
  propagator: Propagator,
  contextOverride?: Record<string, unknown>
): (...args: unknown[]) => unknown {
  return async (...args: unknown[]) => {
    const { context, input } = parseUnaryArgs(contract, method, args, contextOverride);
    const request = makeRequest(contract, method, context, propagator, input);
    const response = await dispatch(request);
    return processResponse(response, errorStrategy);
  };
}

function buildServerStreamMethod(
  contract: ContractDef,
  method: MethodDef,
  dispatch: ClientNext,
  propagator: Propagator,
  contextOverride?: Record<string, unknown>
): (...args: unknown[]) => unknown {
  return (...args: unknown[]) => {
    const { context, input } = parseUnaryArgs(contract, method, args, contextOverride);
    const request = makeRequest(contract, method, context, propagator, input);
    // Routes through the composed middleware chain (not the transport directly). The chain's final
    // hop invokes `transport.invokeServerStream`, throwing here synchronously if it is absent —
    // preserving the existing "transport does not support server streaming" behavior.
    return mapResponseStream(toResponseStream(dispatch(request)));
  };
}

function buildClientStreamMethod(
  contract: ContractDef,
  method: MethodDef,
  transport: ClientTransport,
  errorStrategy: 'throw' | 'result',
  propagator: Propagator,
  contextOverride?: Record<string, unknown>
): (...args: unknown[]) => unknown {
  return async (...args: unknown[]) => {
    if (!transport.invokeClientStream) {
      throw new Error(`Transport does not support client streaming for method "${method.name}".`);
    }
    const { context, inputStream } = parseStreamArgs(contract, method, args, contextOverride);
    const request = makeRequest(contract, method, context, propagator);
    const response = await transport.invokeClientStream(request, inputStream);
    return processResponse(response, errorStrategy);
  };
}

function buildDuplexMethod(
  contract: ContractDef,
  method: MethodDef,
  transport: ClientTransport,
  propagator: Propagator,
  contextOverride?: Record<string, unknown>
): (...args: unknown[]) => unknown {
  return (...args: unknown[]) => {
    if (!transport.invokeDuplex) {
      throw new Error(`Transport does not support duplex streaming for method "${method.name}".`);
    }
    const { context, inputStream } = parseStreamArgs(contract, method, args, contextOverride);
    const request = makeRequest(contract, method, context, propagator);
    return mapResponseStream(transport.invokeDuplex(request, inputStream));
  };
}

/**
 * Build the streaming-capable dispatch chain shared by unary and `serverStream` calls. Middleware
 * composes around a final hop that dispatches by request kind: `serverStream` requests go to
 * `transport.invokeServerStream` (producing a stream), everything else to `transport.invoke`.
 */
function createDispatch(
  transport: ClientTransport,
  middleware: readonly ClientStreamMiddleware[]
): ClientNext {
  const final = ((request: ClientRequest) => {
    if (request.kind === 'serverStream') {
      if (!transport.invokeServerStream) {
        throw new Error(
          `Transport does not support server streaming for method "${request.method}".`
        );
      }
      return transport.invokeServerStream(request);
    }
    return transport.invoke(request);
  }) as ClientNext;

  return composeMiddleware(middleware, final);
}

function buildMethod(
  contract: ContractDef,
  method: MethodDef,
  dispatch: ClientNext,
  transport: ClientTransport,
  errorStrategy: 'throw' | 'result',
  propagator: Propagator,
  contextOverride?: Record<string, unknown>
): (...args: unknown[]) => unknown {
  switch (method.kind) {
    case 'serverStream':
      return buildServerStreamMethod(contract, method, dispatch, propagator, contextOverride);
    case 'clientStream':
      return buildClientStreamMethod(
        contract,
        method,
        transport,
        errorStrategy,
        propagator,
        contextOverride
      );
    case 'duplex':
      return buildDuplexMethod(contract, method, transport, propagator, contextOverride);
    default:
      return buildUnaryMethod(
        contract,
        method,
        dispatch,
        errorStrategy,
        propagator,
        contextOverride
      );
  }
}

// -- Branded client marker --

const CLIENT_BRAND = Symbol('insler.client');

interface BrandedClient {
  [CLIENT_BRAND]: {
    contract: ContractDef;
    transport: ClientTransport;
    dispatch: ClientNext;
    errorStrategy: 'throw' | 'result';
    propagator: Propagator;
  };
}

function createClientImpl<C extends ContractDef>(
  contract: C,
  transport: ClientTransport,
  options?: ClientOptions
): unknown {
  const errorStrategy = options?.errors ?? 'throw';
  const middleware = options?.middleware ?? [];
  const propagator = options?.propagator ?? DEFAULT_PROPAGATOR;

  const dispatch = createDispatch(transport, middleware);

  const client: Record<string, unknown> = {};

  for (const method of contract.methodList) {
    client[method.name] = buildMethod(
      contract,
      method,
      dispatch,
      transport,
      errorStrategy,
      propagator
    );
  }

  Object.defineProperty(client, CLIENT_BRAND, {
    value: { contract, transport, dispatch, errorStrategy, propagator },
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return client;
}

function withContextImpl(client: unknown, context: Record<string, unknown>): unknown {
  const branded = client as BrandedClient;
  const meta = branded[CLIENT_BRAND];

  if (!meta) {
    throw new Error('Client.withContext() requires a client created by Client.create()');
  }

  const { contract, transport, dispatch, errorStrategy, propagator } = meta;

  const scoped: Record<string, unknown> = {};

  for (const method of contract.methodList) {
    scoped[method.name] = buildMethod(
      contract,
      method,
      dispatch,
      transport,
      errorStrategy,
      propagator,
      context
    );
  }

  return scoped;
}

export namespace Client {
  export function create<C extends ContractDef>(
    contract: C,
    transport: ClientTransport,
    options: ResultClientOptions
  ): ContractResultClient<C>;
  export function create<C extends ContractDef>(
    contract: C,
    transport: ClientTransport,
    options?: ThrowClientOptions
  ): ContractClient<C>;
  export function create<C extends ContractDef>(
    contract: C,
    transport: ClientTransport,
    options?: ClientOptions
  ): ContractClient<C> | ContractResultClient<C> {
    return createClientImpl(contract, transport, options) as any;
  }

  export function withContext<C extends ContractDef>(
    client: ContractResultClient<C>,
    context: Record<string, unknown>
  ): ContractResultScopedClient<C>;
  export function withContext<C extends ContractDef>(
    client: ContractClient<C>,
    context: Record<string, unknown>
  ): ContractScopedClient<C>;
  export function withContext<C extends ContractDef>(
    client: ContractClient<C> | ContractResultClient<C>,
    context: Record<string, unknown>
  ): ContractScopedClient<C> | ContractResultScopedClient<C> {
    return withContextImpl(client, context) as any;
  }
}
