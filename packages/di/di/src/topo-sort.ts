import type { Binding } from './types.js';
import { allDepsToArray } from './types.js';

export function topologicalSort(bindings: Map<string, Binding>): string[] {
  const sorted: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(name: string, path: string[]) {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      const cycleStart = path.indexOf(name);
      const cycle = path.slice(cycleStart);
      throw new Error(`Circular dependency: ${[...cycle, name].join(' → ')}`);
    }

    visiting.add(name);
    const binding = bindings.get(name);
    if (binding) {
      for (const dep of allDepsToArray(binding)) {
        visit(dep.name, [...path, name]);
      }
    }
    visiting.delete(name);
    visited.add(name);
    sorted.push(name);
  }

  for (const name of bindings.keys()) {
    visit(name, []);
  }

  return sorted;
}
