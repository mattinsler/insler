import type { Managed } from './managed.js';
import type { AnyToken } from './token.js';

export type AnyDeps = AnyToken | readonly AnyToken[] | Record<string, AnyToken>;

export type Resolve<T> = T | Managed<T> | Promise<T | Managed<T>>;

export interface Binding {
  token: AnyToken;
  deps: AnyDeps;
  afterDeps?: AnyToken[];
  factory: (...args: any[]) => any;
}

export interface LinkContext {
  name: string;
  deps: string[];
  hasBinding(name: string): boolean;
}

export type LinkRule = (ctx: LinkContext) => string[] | undefined;

export interface ManifestBinding {
  name: string;
  deps: string[];
}

export function depsToArray(deps: AnyDeps): AnyToken[] {
  return Array.isArray(deps) ? deps : Object.values(deps);
}

export function allDepsToArray(binding: Binding): AnyToken[] {
  return [...depsToArray(binding.deps), ...(binding.afterDeps ?? [])];
}
