import type { HostMethodRegistration, HostRequest, HostResponse } from '@insler/rpc-host';

export class MemoryBus {
  private readonly handlers = new Map<string, HostMethodRegistration>();

  private static key(service: string, method: string): string {
    return `${service}.${method}`;
  }

  register(service: string, method: string, registration: HostMethodRegistration): () => void {
    const key = MemoryBus.key(service, method);
    if (this.handlers.has(key)) {
      throw new Error(`Handler already registered for '${service}.${method}'`);
    }
    this.handlers.set(key, registration);
    return () => {
      this.handlers.delete(key);
    };
  }

  async invoke(service: string, method: string, request: HostRequest): Promise<HostResponse> {
    const reg = this.handlers.get(MemoryBus.key(service, method));
    if (!reg) {
      return this.notFound(service, method);
    }
    if (reg.kind !== 'unary') {
      return {
        error: {
          _tag: '__kind_mismatch__',
          message: `Expected unary handler for '${service}.${method}'`,
        },
      };
    }
    return reg.handler(request);
  }

  invokeServerStream(
    service: string,
    method: string,
    request: HostRequest
  ): AsyncIterable<HostResponse> {
    const reg = this.handlers.get(MemoryBus.key(service, method));
    if (!reg) {
      return this.singleErrorStream(this.notFound(service, method));
    }
    if (reg.kind !== 'serverStream') {
      return this.singleErrorStream({
        error: {
          _tag: '__kind_mismatch__',
          message: `Expected serverStream handler for '${service}.${method}'`,
        },
      });
    }
    return reg.handler(request);
  }

  async invokeClientStream(
    service: string,
    method: string,
    request: HostRequest,
    inputStream: AsyncIterable<unknown>
  ): Promise<HostResponse> {
    const reg = this.handlers.get(MemoryBus.key(service, method));
    if (!reg) {
      return this.notFound(service, method);
    }
    if (reg.kind !== 'clientStream') {
      return {
        error: {
          _tag: '__kind_mismatch__',
          message: `Expected clientStream handler for '${service}.${method}'`,
        },
      };
    }
    return reg.handler(request, inputStream);
  }

  invokeDuplex(
    service: string,
    method: string,
    request: HostRequest,
    inputStream: AsyncIterable<unknown>
  ): AsyncIterable<HostResponse> {
    const reg = this.handlers.get(MemoryBus.key(service, method));
    if (!reg) {
      return this.singleErrorStream(this.notFound(service, method));
    }
    if (reg.kind !== 'duplex') {
      return this.singleErrorStream({
        error: {
          _tag: '__kind_mismatch__',
          message: `Expected duplex handler for '${service}.${method}'`,
        },
      });
    }
    return reg.handler(request, inputStream);
  }

  private notFound(service: string, method: string): HostResponse {
    return {
      error: {
        _tag: '__not_found__',
        message: `No handler registered for '${service}.${method}'`,
      },
    };
  }

  private async *singleErrorStream(response: HostResponse): AsyncIterable<HostResponse> {
    yield response;
  }
}
