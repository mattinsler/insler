import { type AnyToken, type InferToken, type InferTokens, Token } from './token.js';
import type { AnyDeps } from './types.js';

let nextId = 0;

/**
 * A token produced by {@link inject}. It carries its own dependency tokens and a
 * factory, so it can be registered with a zero-extra-arg `provide(boundToken)`.
 *
 * `BoundToken` is a nominal brand: a plain `Token` is not assignable to it (it
 * lacks `deps`/`factory`), so `provide(normalToken)` with no factory will not
 * compile. The instance is frozen, like every token.
 */
export class BoundToken<T> extends Token<T, void, true> {
  readonly deps: AnyDeps;
  readonly factory: (...args: any[]) => any;

  constructor(name: string, deps: AnyDeps, factory: (...args: any[]) => any) {
    super(name, name, undefined);
    this.deps = deps;
    this.factory = factory;
    Object.freeze(this);
  }
}

// single token
export function inject<D extends AnyToken, A extends any[], R>(
  dep: D,
  fn: (dep: InferToken<D>, ...args: A) => R
): BoundToken<(...args: A) => R>;
// array / tuple
export function inject<const D extends readonly AnyToken[], A extends any[], R>(
  deps: readonly [...D],
  fn: (deps: InferTokens<D>, ...args: A) => R
): BoundToken<(...args: A) => R>;
// record
export function inject<const D extends Record<string, AnyToken>, A extends any[], R>(
  deps: D,
  fn: (deps: InferTokens<D>, ...args: A) => R
): BoundToken<(...args: A) => R>;
/**
 * Bind a set of dependency tokens to a function's first parameter, returning a
 * token that resolves to the partially-applied function — dependency-injected
 * partial application. The first parameter's shape mirrors `provide`: a single
 * token → the resolved value, an array/tuple → the resolved tuple, a record →
 * the resolved object. Remaining parameters stay free for the caller.
 *
 * Pure sugar over `provide`: it desugars to a factory returning
 * `(...resolvedDeps) => (...args) => fn(<deps in declared shape>, ...args)` and
 * resolves eagerly, so `get(token)` returns the callable synchronously. Each call
 * produces a token with a unique identity.
 */
export function inject(deps: AnyDeps, fn: (...args: any[]) => any): BoundToken<any> {
  const name = `inject:${nextId++}`;

  if (deps instanceof Token) {
    return new BoundToken(
      name,
      [deps],
      (dep: unknown) =>
        (...args: unknown[]) =>
          fn(dep, ...args)
    );
  }

  if (Array.isArray(deps)) {
    return new BoundToken(
      name,
      deps,
      (...resolved: unknown[]) =>
        (...args: unknown[]) =>
          fn(resolved, ...args)
    );
  }

  return new BoundToken(
    name,
    deps,
    (resolved: unknown) =>
      (...args: unknown[]) =>
        fn(resolved, ...args)
  );
}
