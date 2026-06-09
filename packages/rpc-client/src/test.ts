import type { ClientRequest, ClientResponse, ClientTransport } from './transport.js';

/**
 * A mock transport that records all invocations and lets you configure responses.
 * Useful for unit-testing code that depends on a client.
 */
export class TestTransport implements ClientTransport {
  private _calls: ClientRequest[] = [];
  private _responses = new Map<string, ClientResponse>();
  private _defaultResponse: ClientResponse | undefined;

  get calls(): ReadonlyArray<ClientRequest> {
    return this._calls;
  }

  /**
   * Configure a response for a specific method.
   */
  on(method: string): {
    returns(output: unknown): void;
    throws(tag: string, payload?: unknown): void;
  } {
    return {
      returns: (output: unknown) => {
        this._responses.set(method, { output });
      },
      throws: (tag: string, payload?: unknown) => {
        this._responses.set(method, { error: { _tag: tag, payload } });
      },
    };
  }

  /**
   * Set a default response for any unmatched method.
   */
  defaultResponse(response: ClientResponse): void {
    this._defaultResponse = response;
  }

  /**
   * Clear all recorded calls and configured responses.
   */
  reset(): void {
    this._calls = [];
    this._responses.clear();
    this._defaultResponse = undefined;
  }

  async invoke(request: ClientRequest): Promise<ClientResponse> {
    this._calls.push(request);

    const configured = this._responses.get(request.method);
    if (configured) {
      return configured;
    }

    if (this._defaultResponse) {
      return this._defaultResponse;
    }

    return {
      error: {
        _tag: '__test_no_response__',
        message: `No response configured for method: ${request.method}`,
      },
    };
  }
}
