// The second service of the fixture fleet: declares a logical need and a
// typed cross-service call against the greeter's contract, so the scanned
// manifest carries both edge types of the dependency graph.
import { Contract } from '@insler/rpc/contract';
import { defineService } from '@insler/service';
import { z } from 'zod';

import { GreeterContract } from './greeter.service.js';

const OrdersContract = Contract.create('orders', {
  version: '1.0.0',
  methods: {
    create: {
      input: z.object({ sku: z.string() }),
      output: z.object({ id: z.string() }),
    },
  },
});

export const orders = defineService({
  name: 'orders',
  kind: 'persistent',
  contract: OrdersContract,
  needs: ['orders-db'],
  calls: [{ contract: GreeterContract, method: 'greet' }],
});
