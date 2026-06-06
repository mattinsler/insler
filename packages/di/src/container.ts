import createDebug from 'debug';

import { BoundToken } from './inject.js';
import { isManaged } from './managed.js';
import { ContainerManifest } from './manifest.js';
import { ResolvedContainer } from './resolved.js';
import { Token } from './token.js';
import type { AnyToken, InferTokens, InferTokensAsArray } from './token.js';
import { topologicalSort } from './topo-sort.js';
import type { AnyDeps, Binding, LinkContext, LinkRule, ManifestBinding, Resolve } from './types.js';
import { allDepsToArray, depsToArray } from './types.js';

const noop = Function.prototype as (...args: any[]) => any;

const debug = createDebug('container');

export class ContainerBuilder {
  readonly #factories = new Map<string, Binding>();
  readonly #bindings = new Map<string, Binding>();
  readonly #initializers: Array<(resolved: ResolvedContainer) => Promise<void>> = [];
  readonly #deferred: Array<(builder: ContainerBuilder) => Promise<void>> = [];
  readonly #linkRules: LinkRule[] = [];

  factory<T, C>(token: Token<T, C>, metaFactory: (config: C) => () => Resolve<T>): this;
  factory<T, C, const D extends readonly AnyToken[]>(
    token: Token<T, C>,
    metaFactory: (config: C) => { deps: [...D]; factory: (...args: InferTokens<D>) => Resolve<T> }
  ): this;
  factory<T, C, const D extends Record<string, AnyToken>>(
    token: Token<T, C>,
    metaFactory: (config: C) => { deps: D; factory: (deps: InferTokens<D>) => Resolve<T> }
  ): this;
  factory<T, C, const D extends AnyDeps>(
    token: Token<T, C>,
    deps: D,
    metaFactory: (config: C) => (...dependencies: InferTokensAsArray<D>) => Resolve<T>
  ): this;
  factory(token: AnyToken, ...args: unknown[]): this {
    if (this.#factories.has(token.baseName)) return this;

    let deps: AnyDeps;
    let metaFactory: (...args: any[]) => any;

    if (args.length === 1) {
      deps = [];
      metaFactory = args[0] as (...args: any[]) => any;
    } else {
      deps = args[0] as AnyDeps;
      metaFactory = args[1] as (...args: any[]) => any;
    }

    this.#factories.set(token.baseName, { token, deps, factory: metaFactory });
    return this;
  }

  lazy<T>(token: Token<T>, factory: () => Resolve<T>): this;
  lazy<T, const D extends Record<string, AnyToken>>(
    token: Token<T>,
    deps: D,
    factory: (dependencies: InferTokens<D>) => Resolve<T>
  ): this;
  lazy<T, const D extends readonly AnyToken[]>(
    token: Token<T>,
    deps: [...D],
    factory: (...args: InferTokens<D>) => Resolve<T>
  ): this;
  lazy(token: AnyToken, ...args: unknown[]): this {
    if (this.#factories.has(token.baseName)) {
      debug('lazy skipped (already registered): %s', token.baseName);
      return this;
    }
    debug('lazy registered: %s', token.baseName);

    let deps: AnyDeps;
    let factory: (...args: any[]) => any;

    if (args.length === 1) {
      deps = [];
      factory = args[0] as (...args: any[]) => any;
    } else {
      deps = args[0] as AnyDeps;
      factory = args[1] as (...args: any[]) => any;
    }

    this.#factories.set(token.baseName, {
      token,
      deps: [],
      factory: () => ({ deps, factory }),
    });
    return this;
  }

  provide<T>(token: BoundToken<T>): this;
  provide<T, C>(token: Token<T, C>, factory: () => Resolve<T>): this;
  provide<T, C, const D extends Record<string, AnyToken>>(
    token: Token<T, C>,
    deps: D,
    factory: (dependencies: InferTokens<D>) => Resolve<T>
  ): this;
  provide<T, C, const D extends readonly AnyToken[]>(
    token: Token<T, C>,
    deps: [...D],
    factory: (...args: InferTokens<D>) => Resolve<T>
  ): this;
  provide(token: AnyToken, ...args: unknown[]): this {
    if (this.#bindings.has(token.name)) return this;

    let deps: AnyDeps;
    let factory: (...args: any[]) => any;

    if (token instanceof BoundToken) {
      // A bound token carries its own deps + factory (see inject()).
      deps = token.deps;
      factory = token.factory;
    } else if (args.length === 1) {
      deps = [];
      factory = args[0] as (...args: any[]) => any;
    } else {
      deps = args[0] as AnyDeps;
      factory = args[1] as (...args: any[]) => any;
    }

    this.#bindings.set(token.name, { token, deps, factory });
    return this;
  }

  use(fn: (builder: this) => this): this {
    return fn(this);
  }

  init(fn: (resolved: ResolvedContainer) => void | Promise<void>): this {
    this.#initializers.push(async (resolved) => {
      await fn(resolved);
    });
    return this;
  }

  defer(fn: (builder: ContainerBuilder) => Promise<void>): this {
    this.#deferred.push(fn);
    return this;
  }

  link(rule: LinkRule): this {
    this.#linkRules.push(rule);
    return this;
  }

  manifest(): ContainerManifest {
    const bindings = new Map(this.#bindings);
    const factories = new Map(this.#factories);

    let changed = true;
    while (changed) {
      changed = false;
      for (const binding of bindings.values()) {
        for (const dep of depsToArray(binding.deps)) {
          if (bindings.has(dep.name)) continue;
          const factoryBinding = factories.get(dep.baseName);
          if (!factoryBinding) continue;

          try {
            const result = factoryBinding.factory(dep.config);
            let innerDeps: AnyDeps;
            if (typeof result === 'function') {
              innerDeps = factoryBinding.deps;
            } else {
              innerDeps = result.deps ?? factoryBinding.deps;
            }
            bindings.set(dep.name, { token: dep, deps: innerDeps, factory: noop });
            changed = true;
          } catch {
            // factory expansion failed — skip
          }
        }
      }
    }

    const unresolved: string[] = [];
    for (const [, binding] of bindings) {
      for (const dep of depsToArray(binding.deps)) {
        if (!bindings.has(dep.name) && !unresolved.includes(dep.name)) {
          unresolved.push(dep.name);
        }
      }
    }

    const sortable = new Map<string, Binding>();
    for (const [name, binding] of bindings) {
      const resolvedDeps = depsToArray(binding.deps).filter((d) => bindings.has(d.name));
      sortable.set(name, { ...binding, deps: resolvedDeps });
    }

    let order: string[];
    try {
      order = topologicalSort(sortable);
    } catch {
      order = [...sortable.keys()];
    }

    const nodeLevel = new Map<string, number>();
    for (const name of order) {
      const binding = sortable.get(name)!;
      const deps = depsToArray(binding.deps);
      const maxDepLevel =
        deps.length > 0 ? Math.max(...deps.map((d) => nodeLevel.get(d.name) ?? 0)) : -1;
      nodeLevel.set(name, maxDepLevel + 1);
    }

    const manifestBindings: ManifestBinding[] = order.map((name) => ({
      name,
      deps: allDepsToArray(bindings.get(name)!).map((d) => d.name),
    }));

    const maxLevel = Math.max(0, ...nodeLevel.values());
    const levels: ManifestBinding[][] = [];
    for (let i = 0; i <= maxLevel; i++) levels.push([]);
    for (const b of manifestBindings) {
      const level = nodeLevel.get(b.name) ?? 0;
      levels[level]!.push(b);
    }

    const manifestFactories = [...factories.values()].map((f) => ({
      baseName: f.token.baseName,
      deps: depsToArray(f.deps).map((d) => d.name),
    }));

    return new ContainerManifest({
      bindings: manifestBindings,
      factories: manifestFactories,
      levels,
      initializerCount: this.#initializers.length,
      deferredCount: this.#deferred.length,
      unresolved,
    });
  }

  #applyLinkRules() {
    if (this.#linkRules.length === 0) return;

    for (const [name, binding] of this.#bindings) {
      const ctx: LinkContext = {
        name,
        deps: depsToArray(binding.deps).map((d) => d.name),
        hasBinding: (n) => this.#bindings.has(n),
      };

      const newAfterDeps: AnyToken[] = [];
      for (const rule of this.#linkRules) {
        const result = rule(ctx);
        if (result) {
          for (const depName of result) {
            if (this.#bindings.has(depName)) {
              newAfterDeps.push(new Token(depName, depName, undefined));
            }
          }
        }
      }

      if (newAfterDeps.length > 0) {
        this.#bindings.set(name, {
          ...binding,
          afterDeps: [...(binding.afterDeps ?? []), ...newAfterDeps],
        });
      }
    }
  }

  #expandFactories() {
    let changed = true;
    while (changed) {
      changed = false;
      for (const binding of this.#bindings.values()) {
        for (const dep of depsToArray(binding.deps)) {
          if (this.#bindings.has(dep.name)) continue;

          const factoryBinding = this.#factories.get(dep.baseName);
          if (!factoryBinding) {
            debug('expand: no factory for dep %s (baseName: %s)', dep.name, dep.baseName);
            continue;
          }
          debug('expand: expanding %s via factory %s', dep.name, dep.baseName);

          const result = factoryBinding.factory(dep.config);

          let innerFactory: (...args: any[]) => any;
          let innerDeps: AnyDeps;

          if (typeof result === 'function') {
            innerFactory = result;
            innerDeps = factoryBinding.deps;
          } else {
            innerFactory = result.factory;
            innerDeps = result.deps ?? factoryBinding.deps;
          }

          this.#bindings.set(dep.name, {
            token: dep,
            deps: innerDeps,
            factory: innerFactory,
          });
          changed = true;
        }
      }
    }
  }

  async start(): Promise<ResolvedContainer> {
    if (this.#deferred.length > 0) {
      debug('resolving %d deferred registrations', this.#deferred.length);
      for (const fn of this.#deferred) {
        await fn(this);
      }
    }

    debug('expanding factories');
    this.#expandFactories();

    if (this.#linkRules.length > 0) {
      debug('applying %d link rules', this.#linkRules.length);
      this.#applyLinkRules();
    }

    for (const [name, binding] of this.#bindings) {
      for (const dep of allDepsToArray(binding)) {
        if (!this.#bindings.has(dep.name)) {
          throw new Error(`Token "${name}" depends on "${dep.name}" which is not provided`);
        }
      }
    }

    const order = topologicalSort(this.#bindings);
    debug('resolved %d bindings in dependency order', order.length);

    const nodeLevel = new Map<string, number>();
    for (const name of order) {
      const binding = this.#bindings.get(name)!;
      const all = allDepsToArray(binding);
      const maxDepLevel = all.length > 0 ? Math.max(...all.map((d) => nodeLevel.get(d.name)!)) : -1;
      nodeLevel.set(name, maxDepLevel + 1);
    }

    const levels: string[][] = [];
    for (const name of order) {
      const level = nodeLevel.get(name)!;
      while (levels.length <= level) levels.push([]);
      levels[level]!.push(name);
    }

    debug('starting resolution across %d levels', levels.length);

    const values = new Map<string, unknown>();
    const stopCallbacks = new Map<string, () => Promise<void>>();

    try {
      for (let i = 0; i < levels.length; i++) {
        const level = levels[i]!;
        debug('level %d: resolving %o', i, level);
        const results = await Promise.allSettled(
          level.map(async (name) => {
            const binding = this.#bindings.get(name)!;

            let result: unknown;
            if (Array.isArray(binding.deps)) {
              const depValues = binding.deps.map((dep) => values.get(dep.name));
              result = await binding.factory(...depValues);
            } else {
              const depRecord = Object.fromEntries(
                Object.entries(binding.deps).map(([key, dep]) => [
                  key,
                  values.get((dep as AnyToken).name),
                ])
              );
              result = await binding.factory(depRecord);
            }

            if (isManaged(result)) {
              values.set(name, result.value);
              if (result.stop) stopCallbacks.set(name, result.stop);
            } else {
              values.set(name, result);
            }
          })
        );

        const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failure) throw failure.reason;
      }
    } catch (error) {
      debug('resolution failed, stopping %d resolved bindings', stopCallbacks.size);
      const toStop = [...stopCallbacks.keys()].reverse();
      for (const key of toStop) {
        try {
          await stopCallbacks.get(key)!();
        } catch {
          // swallow during failure cleanup
        }
      }
      throw error;
    }

    const resolved = new ResolvedContainer(
      values,
      stopCallbacks,
      [...order].reverse(),
      this.#factories
    );

    if (this.#initializers.length > 0) {
      debug('running %d initializers', this.#initializers.length);
      try {
        for (const fn of this.#initializers) {
          await fn(resolved);
        }
      } catch (error) {
        await resolved.stop().catch(() => {});
        throw error;
      }
    }

    debug('container started');
    return resolved;
  }
}

export function container(): ContainerBuilder {
  return new ContainerBuilder();
}

export function withDeps<const D extends readonly AnyToken[], T>(
  deps: [...D],
  factory: (...args: InferTokens<D>) => Resolve<T>
): { deps: [...D]; factory: (...args: InferTokens<D>) => Resolve<T> };
export function withDeps<const D extends Record<string, AnyToken>, T>(
  deps: D,
  factory: (deps: InferTokens<D>) => Resolve<T>
): { deps: D; factory: (deps: InferTokens<D>) => Resolve<T> };
export function withDeps(deps: AnyDeps, factory: (...args: any[]) => any) {
  return { deps, factory };
}
