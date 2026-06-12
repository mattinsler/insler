import { type Managed, isManaged } from './managed.js';
import { Token } from './token.js';
import type { AnyToken, InferTokens, LazyToken } from './token.js';
import type { AnyDeps, Binding } from './types.js';
import { depsToArray } from './types.js';

export class ResolvedContainer {
  readonly #values: Map<string, unknown>;
  readonly #stopCallbacks: Map<string, () => Promise<void>>;
  readonly #stopOrder: string[];
  readonly #factories: Map<string, Binding>;
  readonly #resolving = new Map<string, Promise<unknown>>();

  constructor(
    values: Map<string, unknown>,
    stopCallbacks: Map<string, () => Promise<void>>,
    stopOrder: string[],
    factories: Map<string, Binding>
  ) {
    this.#values = values;
    this.#stopCallbacks = stopCallbacks;
    this.#stopOrder = stopOrder;
    this.#factories = factories;
  }

  get<T>(token: Token<T, any, true>): T {
    if (!this.#values.has(token.name)) {
      throw new Error(`Token "${token.name}" was not provided`);
    }
    return this.#values.get(token.name) as T;
  }

  async resolve<T>(token: LazyToken<T, any>): Promise<T> {
    return this.#resolveAny(token) as Promise<T>;
  }

  resolveAll<const D extends AnyDeps>(deps: D): Promise<InferTokens<D>> {
    if (deps instanceof Token) {
      return this.#resolveAny(deps) as Promise<InferTokens<D>>;
    }
    if (Array.isArray(deps)) {
      return Promise.all(deps.map((dep) => this.#resolveAny(dep))) as unknown as Promise<
        InferTokens<D>
      >;
    } else {
      return Promise.all(
        Object.entries(deps).map(async ([key, dep]) => [key, await this.#resolveAny(dep)])
      ).then((entries) => Object.fromEntries(entries));
    }
  }

  async #resolveAny(token: AnyToken): Promise<unknown> {
    if (this.#values.has(token.name)) {
      return this.#values.get(token.name);
    }

    let pending = this.#resolving.get(token.name);
    if (!pending) {
      pending = this.#lazyExpand(token);
      this.#resolving.set(token.name, pending);
    }
    return pending;
  }

  async #lazyExpand(token: AnyToken): Promise<unknown> {
    const factoryBinding = this.#factories.get(token.baseName);
    if (!factoryBinding) {
      throw new Error(
        `Token "${token.name}" was not provided and no factory "${token.baseName}" is registered`
      );
    }

    const result = factoryBinding.factory(token.config);
    let innerFactory: (...args: any[]) => any;
    let innerDeps: AnyDeps;

    if (typeof result === 'function') {
      innerFactory = result;
      innerDeps = factoryBinding.deps;
    } else {
      innerFactory = result.factory;
      innerDeps = result.deps ?? factoryBinding.deps;
    }

    const depTokens = depsToArray(innerDeps);
    const resolvedDeps = await Promise.all(depTokens.map((dep) => this.#resolveAny(dep)));

    let value: unknown;
    if (Array.isArray(innerDeps)) {
      value = await innerFactory(...resolvedDeps);
    } else {
      const depRecord = Object.fromEntries(
        Object.keys(innerDeps).map((key, i) => [key, resolvedDeps[i]])
      );
      value = await innerFactory(depRecord);
    }

    if (isManaged(value)) {
      this.#values.set(token.name, (value as Managed<unknown>).value);
      if ((value as Managed<unknown>).stop) {
        this.#stopCallbacks.set(token.name, (value as Managed<unknown>).stop!);
        this.#stopOrder.unshift(token.name);
      }
      return (value as Managed<unknown>).value;
    }

    this.#values.set(token.name, value);
    return value;
  }

  async stop(): Promise<void> {
    const errors: Array<{ name: string; error: unknown }> = [];
    for (const name of this.#stopOrder) {
      const stop = this.#stopCallbacks.get(name);
      if (stop) {
        try {
          await stop();
        } catch (error) {
          errors.push({ name, error });
        }
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors.map((e) => e.error),
        `Container shutdown errors: ${errors.map((e) => e.name).join(', ')}`
      );
    }
  }
}
