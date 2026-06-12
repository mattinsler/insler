import type { ClientRequest, ClientResponse, ClientTransport } from '../client/index.js';
import type { HostRequest, HostResponse } from '../host/index.js';
import type { MemoryBus } from './bus.js';

function toHostRequest(request: ClientRequest): HostRequest {
  return {
    service: request.service,
    method: request.method,
    kind: request.kind,
    input: request.input,
    metadata: request.metadata,
  };
}

function toClientResponse(response: HostResponse): ClientResponse {
  return {
    output: response.output,
    error: response.error,
  };
}

export class MemoryClientTransport implements ClientTransport {
  constructor(private readonly bus: MemoryBus) {}

  async invoke(request: ClientRequest): Promise<ClientResponse> {
    const response = await this.bus.invoke(request.service, request.method, toHostRequest(request));
    return toClientResponse(response);
  }

  async *invokeServerStream(request: ClientRequest): AsyncIterable<ClientResponse> {
    for await (const response of this.bus.invokeServerStream(
      request.service,
      request.method,
      toHostRequest(request)
    )) {
      yield toClientResponse(response);
    }
  }

  async invokeClientStream(
    request: ClientRequest,
    inputStream: AsyncIterable<unknown>
  ): Promise<ClientResponse> {
    const response = await this.bus.invokeClientStream(
      request.service,
      request.method,
      toHostRequest(request),
      inputStream
    );
    return toClientResponse(response);
  }

  async *invokeDuplex(
    request: ClientRequest,
    inputStream: AsyncIterable<unknown>
  ): AsyncIterable<ClientResponse> {
    for await (const response of this.bus.invokeDuplex(
      request.service,
      request.method,
      toHostRequest(request),
      inputStream
    )) {
      yield toClientResponse(response);
    }
  }
}
