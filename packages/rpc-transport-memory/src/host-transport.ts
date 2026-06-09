import type { HostRegistration, HostTransport, HostUnregister } from '@insler/rpc-host';

import type { MemoryBus } from './bus.js';

export class MemoryHostTransport implements HostTransport {
  constructor(private readonly bus: MemoryBus) {}

  async register(registration: HostRegistration): Promise<HostUnregister> {
    const unregisters: (() => void)[] = [];

    for (const method of registration.methods) {
      const unregister = this.bus.register(registration.service, method.method, method);
      unregisters.push(unregister);
    }

    return async () => {
      for (const unregister of unregisters) {
        unregister();
      }
    };
  }
}
