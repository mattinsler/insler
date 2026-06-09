/**
 * Error thrown when a contract method returns a typed error and
 * the client is configured with `errors: 'throw'` (the default).
 */
export class ContractError extends Error {
  readonly _tag: string;
  readonly payload: unknown;

  constructor(tag: string, payload?: unknown, message?: string) {
    super(message ?? `ContractError: ${tag}`);
    this.name = 'ContractError';
    this._tag = tag;
    this.payload = payload;
  }
}
