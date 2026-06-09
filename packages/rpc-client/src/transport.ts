import type { MethodKind } from '@insler/rpc-contract';

/**
 * A request sent from the client to the transport layer.
 */
export interface ClientRequest {
  readonly service: string;
  readonly method: string;
  readonly kind: MethodKind;
  readonly input?: unknown;
  readonly metadata?: Record<string, string>;
}

/**
 * A response received from the transport layer.
 */
export interface ClientResponse {
  readonly output?: unknown;
  readonly error?: { _tag: string; payload?: unknown; message?: string };
}

export interface ClientTransport {
  invoke(request: ClientRequest): Promise<ClientResponse>;
  invokeServerStream?(request: ClientRequest): AsyncIterable<ClientResponse>;
  invokeClientStream?(
    request: ClientRequest,
    inputStream: AsyncIterable<unknown>
  ): Promise<ClientResponse>;
  invokeDuplex?(
    request: ClientRequest,
    inputStream: AsyncIterable<unknown>
  ): AsyncIterable<ClientResponse>;
}
