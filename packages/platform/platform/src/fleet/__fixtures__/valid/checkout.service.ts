import { Contract } from '@insler/rpc/contract';
import { defineService } from '@insler/service';
import type { ServiceDef } from '@insler/service';
import { z } from 'zod';

const CheckoutContract = Contract.create('checkout', {
  version: '1.0.0',
  methods: {
    start: { input: z.object({ cart: z.string() }), output: z.object({ ok: z.boolean() }) },
  },
});

// A consumer: calls the orders producer by its subject, declares a need, and
// exposes an HTTP route. Exercises every edge/route source in one declaration.
export const checkout: ServiceDef = defineService({
  name: 'checkout',
  kind: 'ephemeral',
  contract: CheckoutContract,
  needs: ['valkey'],
  calls: ['orders.create'],
  expose: { http: { method: 'POST', path: '/checkout', handler: 'start' } },
});
