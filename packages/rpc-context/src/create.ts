import type { Serde } from '@insler/serde';

import type { Propagator } from './propagator.js';

export function createPropagator(serde: Serde<string>): Propagator {
  return {
    inject(context, carrier) {
      for (const [key, value] of Object.entries(context)) {
        carrier[key] = serde.encode(value);
      }
    },

    extract(keys, carrier) {
      const context: Record<string, unknown> = {};
      for (const key of keys) {
        const raw = carrier[key];
        if (raw !== undefined) {
          context[key] = serde.decode(raw);
        }
      }
      return context;
    },
  };
}
