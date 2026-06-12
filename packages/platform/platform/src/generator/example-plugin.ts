import type { GeneratedFile, GeneratorOptions, GeneratorPlugin } from './types.js';

/**
 * A deliberately trivial reference plugin: it emits a single JSON inventory of
 * the fleet (service names + kinds) for the run's environment. It exists to
 * exercise the engine end-to-end and to give `insler generate` something real
 * to produce before the artifact generators (#0012–#0019) land — it is NOT one
 * of those generators and produces no deployment artifacts.
 */
export const fleetInventoryPlugin: GeneratorPlugin = {
  name: 'fleet-inventory',
  generate(manifest, options: GeneratorOptions): readonly GeneratedFile[] {
    const inventory = {
      environment: options.environment,
      target: options.target,
      // Sorted for deterministic output (Notes).
      services: [...manifest.services]
        .map((service) => ({ kind: service.kind, name: service.name }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    };
    return [
      {
        path: 'fleet-inventory.json',
        content: `${JSON.stringify(inventory, null, 2)}\n`,
        format: 'json',
      },
    ];
  },
};
