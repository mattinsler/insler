import objectHash from 'object-hash';

export class Token<T = any, Config = void, Eager extends boolean = true> {
  declare readonly __type: T;
  declare readonly __eager: Eager;
  readonly name: string;
  readonly baseName: string;
  readonly config: Config;

  constructor(name: string, baseName: string, config: Config) {
    this.name = name;
    this.baseName = baseName;
    this.config = config;
    // Freeze plain tokens here; a sanctioned subclass (BoundToken) sets its own
    // fields and freezes itself, so the immutability invariant is preserved
    // without freezing before the subclass can finish constructing.
    if (new.target === Token) Object.freeze(this);
  }
}

export type LazyToken<T = any, Config = void> = Token<T, Config, false>;
export type AnyToken = Token<any, any, boolean>;

export type InferToken<T> = T extends Token<infer V, any, any> ? V : never;

export type InferTokens<T> = T extends AnyToken
  ? InferToken<T>
  : T extends readonly AnyToken[]
    ? {
        [K in keyof T]: InferToken<T[K]>;
      }
    : T extends Record<string, AnyToken>
      ? {
          [K in keyof T]: InferToken<T[K]>;
        }
      : never;

export type InferTokensAsArray<T> = T extends readonly AnyToken[]
  ? {
      [K in keyof T]: InferToken<T[K]>;
    }
  : T extends Record<string, AnyToken>
    ? [
        {
          [K in keyof T]: InferToken<T[K]>;
        },
      ]
    : never;

export function token<T>(name: string): Token<T>;
export function token<T, C>(name: string, config: C): Token<T, C>;
export function token(name: string, config?: unknown): Token<any, any> {
  return new Token(name, name, config);
}

export function factoryToken<T, Config = void>(name: string): Token<T, Config> {
  return new Token(name, name, undefined as Config);
}

export function parameterizedToken<T>(name: string, parameter: objectHash.NotUndefined): Token<T>;
export function parameterizedToken<T, C>(
  name: string,
  parameter: objectHash.NotUndefined,
  config: C
): Token<T, C>;
export function parameterizedToken(
  name: string,
  parameter: objectHash.NotUndefined,
  config?: unknown
): Token<any, any> {
  config = config ?? parameter;
  switch (typeof parameter) {
    case 'string':
    case 'number':
      return new Token(`${name}:${parameter}`, name, config);
    default:
      return new Token(`${name}:${objectHash(parameter)}`, name, config);
  }
}

export function lazyToken<T>(name: string, parameter: objectHash.NotUndefined): LazyToken<T>;
export function lazyToken<T, C>(name: string, parameter: objectHash.NotUndefined): LazyToken<T, C>;
export function lazyToken<T, C>(
  name: string,
  parameter: objectHash.NotUndefined,
  config: C
): LazyToken<T, C>;
export function lazyToken(
  name: string,
  parameter: objectHash.NotUndefined,
  config?: unknown
): LazyToken<any, any> {
  config = config ?? parameter;
  switch (typeof parameter) {
    case 'string':
    case 'number':
      return new Token(`${name}:${parameter}`, name, config) as LazyToken<any, any>;
    default:
      return new Token(`${name}:${objectHash(parameter)}`, name, config) as LazyToken<any, any>;
  }
}
