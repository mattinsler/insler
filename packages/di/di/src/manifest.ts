import type { ManifestBinding } from './types.js';

export class ContainerManifest {
  readonly bindings: ManifestBinding[];
  readonly factories: Array<{ baseName: string; deps: string[] }>;
  readonly levels: ManifestBinding[][];
  readonly initializerCount: number;
  readonly deferredCount: number;
  readonly unresolved: string[];

  constructor(data: {
    bindings: ManifestBinding[];
    factories: Array<{ baseName: string; deps: string[] }>;
    levels: ManifestBinding[][];
    initializerCount: number;
    deferredCount: number;
    unresolved: string[];
  }) {
    this.bindings = data.bindings;
    this.factories = data.factories;
    this.levels = data.levels;
    this.initializerCount = data.initializerCount;
    this.deferredCount = data.deferredCount;
    this.unresolved = data.unresolved;
  }

  tree(name: string): string {
    const byName = new Map(this.bindings.map((b) => [b.name, b]));
    const lines: string[] = [name];
    const visited = new Set<string>();

    const render = (nodeName: string, prefix: string, isLast: boolean) => {
      const connector = isLast ? '└── ' : '├── ';
      lines.push(prefix + connector + nodeName);

      if (visited.has(nodeName)) {
        lines.push(prefix + (isLast ? '    ' : '│   ') + '(circular)');
        return;
      }
      visited.add(nodeName);

      const node = byName.get(nodeName);
      if (node) {
        node.deps.forEach((dep, i) => {
          render(dep, prefix + (isLast ? '    ' : '│   '), i === node.deps.length - 1);
        });
      }

      visited.delete(nodeName);
    };

    const root = byName.get(name);
    if (root) {
      root.deps.forEach((dep, i) => {
        render(dep, '', i === root.deps.length - 1);
      });
    }

    return lines.join('\n');
  }

  toString(): string {
    const lines: string[] = ['=== Container Dependency Manifest ===', ''];

    for (let i = 0; i < this.levels.length; i++) {
      const level = this.levels[i]!;
      lines.push(`Level ${i}:`);
      for (const binding of level) {
        if (binding.deps.length === 0) {
          lines.push(`  ${binding.name}`);
        } else {
          lines.push(`  ${binding.name} → [${binding.deps.join(', ')}]`);
        }
      }
      lines.push('');
    }

    if (this.factories.length > 0) {
      lines.push('Factories:');
      for (const f of this.factories) {
        if (f.deps.length === 0) {
          lines.push(`  ${f.baseName}`);
        } else {
          lines.push(`  ${f.baseName} → [${f.deps.join(', ')}]`);
        }
      }
      lines.push('');
    }

    if (this.unresolved.length > 0) {
      lines.push(`Unresolved: ${this.unresolved.join(', ')}`);
      lines.push('');
    }

    if (this.deferredCount > 0) {
      lines.push(`Deferred: ${this.deferredCount} (resolved before binding expansion)`);
    }
    if (this.initializerCount > 0) {
      lines.push(`Initializers: ${this.initializerCount} (run after all bindings resolve)`);
    }

    return lines.join('\n');
  }
}
