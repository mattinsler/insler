import { Contract } from '@insler/rpc/contract';
import { defineService } from '@insler/service';
import type { ServiceDef } from '@insler/service';
import { z } from 'zod';

const OrdersContract = Contract.create('orders', {
  version: '1.0.0',
  methods: {
    create: { input: z.object({ sku: z.string() }), output: z.object({ id: z.string() }) },
  },
});

export const orders: ServiceDef = defineService({
  name: 'orders',
  kind: 'persistent',
  contract: OrdersContract,
  needs: ['orders-db'],
  expose: { http: { method: 'POST', path: '/orders', handler: 'create' } },
});
