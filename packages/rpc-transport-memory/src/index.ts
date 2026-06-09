export { MemoryBus } from './bus.js';
export { MemoryClientTransport } from './client-transport.js';
export { MemoryHostTransport } from './host-transport.js';

import { MemoryBus } from './bus.js';
import { MemoryClientTransport } from './client-transport.js';
import { MemoryHostTransport } from './host-transport.js';

/**
 * Create a connected in-memory transport pair (client + host) backed by a shared bus.
 *
 * This is the primary convenience function for setting up in-process communication:
 * - Local development (everything in one process, no external dependencies)
 * - Testing (spin up client+host pairs instantly)
 * - Monolith mode (multiple services in one process)
 */
export function createMemoryTransport(): {
  bus: MemoryBus;
  client: MemoryClientTransport;
  host: MemoryHostTransport;
} {
  const bus = new MemoryBus();
  return {
    bus,
    client: new MemoryClientTransport(bus),
    host: new MemoryHostTransport(bus),
  };
}
