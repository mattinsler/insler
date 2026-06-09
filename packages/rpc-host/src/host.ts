import type { Propagator } from '@insler/rpc-context';
import { createPropagator } from '@insler/rpc-context';
import type { ContractDef, MethodDef } from '@insler/rpc-contract';
import { safeParse } from 'zod';

import { composeMiddleware } from './middleware.js';
import type { HostMiddleware, HostStreamMiddleware } from './middleware.js';
import type {
  HostClientStreamHandler,
  HostDuplexHandler,
  HostHandler,
  HostMethodRegistration,
  HostRequest,
  HostResponse,
  HostStreamHandler,
  HostTransport,
} from './transport.js';

const DEFAULT_PROPAGATOR = createPropagator({
  encode: (value) => JSON.stringify(value),
  decode: (wire) => JSON.parse(wire),
});

export interface HostInstance {
  stop(): Promise<void>;
}

export interface HostOptions {
  middleware?: HostStreamMiddleware[];
  propagator?: Propagator;
}

function extractContext(
  methodDef: MethodDef,
  contractContext: Record<string, unknown>,
  metadata: Record<string, string> | undefined,
  propagator: Propagator
): Record<string, unknown> | undefined {
  const contextSchemas = methodDef.context !== undefined ? methodDef.context : contractContext;

  if (Object.keys(contextSchemas).length === 0) {
    return undefined;
  }

  if (!metadata) {
    return {};
  }

  return propagator.extract(Object.keys(contextSchemas), metadata);
}

function isVoidSchema(schema: MethodDef['input']): boolean {
  return schema._zod.def.type === 'void';
}

function toErrorResponse(error: unknown): HostResponse {
  if (error !== null && error !== undefined && typeof error === 'object' && '_tag' in error) {
    const contractError = error as { _tag: string; payload?: unknown; message?: string };
    return {
      error: {
        _tag: contractError._tag,
        payload: contractError.payload,
        message: contractError.message,
      },
    };
  }
  return {
    error: {
      _tag: '__unknown__',
      message: error instanceof Error ? error.message : 'Unknown error',
    },
  };
}

function validateInput(
  methodDef: MethodDef,
  input: unknown
): { ok: true; value: unknown } | { ok: false; response: HostResponse } {
  const inputResult = safeParse(methodDef.input, input);
  if (!inputResult.success) {
    return {
      ok: false,
      response: {
        error: {
          _tag: '__validation__',
          message: `Input validation failed: ${String(inputResult.error)}`,
        },
      },
    };
  }
  return { ok: true, value: inputResult.data };
}

function validateOutput(methodDef: MethodDef, result: unknown): HostResponse {
  if (isVoidSchema(methodDef.output)) {
    return { output: result };
  }
  const outputResult = safeParse(methodDef.output, result);
  if (!outputResult.success) {
    return {
      error: {
        _tag: '__validation__',
        message: `Output validation failed: ${String(outputResult.error)}`,
      },
    };
  }
  return { output: outputResult.data };
}

function buildHandlerArgs(
  contract: ContractDef,
  methodDef: MethodDef,
  request: HostRequest,
  propagator: Propagator
): { ok: true; args: unknown[] } | { ok: false; response: HostResponse } {
  const context = extractContext(methodDef, contract.context, request.metadata, propagator);
  const hasVoidInput = isVoidSchema(methodDef.input);

  const args: unknown[] = [];
  if (context !== undefined) {
    args.push(context);
  }

  if (!hasVoidInput) {
    const result = validateInput(methodDef, request.input);
    if (!result.ok) return { ok: false, response: result.response };
    args.push(result.value);
  }

  return { ok: true, args };
}

function wrapHandler(
  contract: ContractDef,
  methodDef: MethodDef,
  handler: (...args: unknown[]) => unknown,
  propagator: Propagator
): HostHandler {
  return async (request: HostRequest): Promise<HostResponse> => {
    try {
      const prep = buildHandlerArgs(contract, methodDef, request, propagator);
      if (!prep.ok) return prep.response;

      const result = await (handler as (...a: unknown[]) => Promise<unknown>)(...prep.args);
      return validateOutput(methodDef, result);
    } catch (error: unknown) {
      return toErrorResponse(error);
    }
  };
}

function wrapServerStreamHandler(
  contract: ContractDef,
  methodDef: MethodDef,
  handler: (...args: unknown[]) => unknown,
  propagator: Propagator
): HostStreamHandler {
  return async function* (request: HostRequest): AsyncIterable<HostResponse> {
    const prep = buildHandlerArgs(contract, methodDef, request, propagator);
    if (!prep.ok) {
      yield prep.response;
      return;
    }

    try {
      const iterable = (handler as (...a: unknown[]) => AsyncIterable<unknown>)(...prep.args);
      for await (const item of iterable) {
        const out = validateOutput(methodDef, item);
        if (out.error) {
          yield out;
          return;
        }
        yield out;
      }
    } catch (error: unknown) {
      yield toErrorResponse(error);
    }
  };
}

async function* createValidatedInputStream(
  methodDef: MethodDef,
  stream: AsyncIterable<unknown>
): AsyncIterable<unknown> {
  for await (const item of stream) {
    const result = validateInput(methodDef, item);
    if (!result.ok) {
      throw {
        _tag: '__validation__',
        message: result.response.error!.message,
      };
    }
    yield result.value;
  }
}

function wrapClientStreamHandler(
  contract: ContractDef,
  methodDef: MethodDef,
  handler: (...args: unknown[]) => unknown,
  propagator: Propagator
): HostClientStreamHandler {
  return async (
    request: HostRequest,
    inputStream: AsyncIterable<unknown>
  ): Promise<HostResponse> => {
    try {
      const context = extractContext(methodDef, contract.context, request.metadata, propagator);
      const hasVoidInput = isVoidSchema(methodDef.input);
      const stream = hasVoidInput
        ? inputStream
        : createValidatedInputStream(methodDef, inputStream);

      const args: unknown[] = [];
      if (context !== undefined) args.push(context);
      args.push(stream);

      const result = await (handler as (...a: unknown[]) => Promise<unknown>)(...args);
      return validateOutput(methodDef, result);
    } catch (error: unknown) {
      return toErrorResponse(error);
    }
  };
}

function wrapDuplexHandler(
  contract: ContractDef,
  methodDef: MethodDef,
  handler: (...args: unknown[]) => unknown,
  propagator: Propagator
): HostDuplexHandler {
  return async function* (
    request: HostRequest,
    inputStream: AsyncIterable<unknown>
  ): AsyncIterable<HostResponse> {
    const context = extractContext(methodDef, contract.context, request.metadata, propagator);
    const hasVoidInput = isVoidSchema(methodDef.input);
    const stream = hasVoidInput ? inputStream : createValidatedInputStream(methodDef, inputStream);

    const args: unknown[] = [];
    if (context !== undefined) args.push(context);
    args.push(stream);

    try {
      const iterable = (handler as (...a: unknown[]) => AsyncIterable<unknown>)(...args);
      for await (const item of iterable) {
        const out = validateOutput(methodDef, item);
        if (out.error) {
          yield out;
          return;
        }
        yield out;
      }
    } catch (error: unknown) {
      yield toErrorResponse(error);
    }
  };
}

export namespace Host {
  export async function create(
    contract: ContractDef,
    handlers: Record<string, (...args: unknown[]) => unknown>,
    transport: HostTransport,
    options?: HostOptions
  ): Promise<HostInstance> {
    const middleware = options?.middleware ?? [];
    const propagator = options?.propagator ?? DEFAULT_PROPAGATOR;
    const methods: HostMethodRegistration[] = [];

    for (const methodDef of contract.methodList) {
      const handler = handlers[methodDef.name];
      if (!handler) {
        throw new Error(
          `Missing handler for method '${methodDef.name}' in contract '${contract.kind}'`
        );
      }

      if (methodDef.kind === 'unary') {
        let wrappedHandler = wrapHandler(contract, methodDef, handler, propagator);
        if (middleware.length > 0) {
          // The same middleware list dispatches two ways; for unary it composes around a
          // `Promise<HostResponse>` handler. Narrowing to the unary element type is safe because
          // composition only threads the request to `next`.
          wrappedHandler = composeMiddleware(middleware as HostMiddleware[], wrappedHandler);
        }
        methods.push({ method: methodDef.name, kind: 'unary', handler: wrappedHandler });
      } else if (methodDef.kind === 'serverStream') {
        let streamHandler = wrapServerStreamHandler(contract, methodDef, handler, propagator);
        if (middleware.length > 0) {
          // Wrap the registered serverStream handler with the same chain as unary, keeping
          // validation / context-extraction / exception-safety inside the middleware envelope so
          // middleware sees the request before validation runs.
          streamHandler = composeMiddleware(middleware, streamHandler);
        }
        methods.push({ method: methodDef.name, kind: 'serverStream', handler: streamHandler });
      } else if (methodDef.kind === 'clientStream') {
        methods.push({
          method: methodDef.name,
          kind: 'clientStream',
          handler: wrapClientStreamHandler(contract, methodDef, handler, propagator),
        });
      } else if (methodDef.kind === 'duplex') {
        methods.push({
          method: methodDef.name,
          kind: 'duplex',
          handler: wrapDuplexHandler(contract, methodDef, handler, propagator),
        });
      }
    }

    const unregister = await transport.register({
      service: contract.kind,
      methods,
    });

    return {
      stop: () => unregister(),
    };
  }
}
