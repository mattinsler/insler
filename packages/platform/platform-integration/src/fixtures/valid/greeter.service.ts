// A declaration file exactly as a platform consumer authors one: a
// defineService around an rpc contract, in a `*.service.ts` file the fleet
// scanner discovers by convention. The contract is exported so a sibling
// declaration can make a typed call against it.
import { Contract } from '@insler/rpc/contract';
import { defineService } from '@insler/service';
import { z } from 'zod';

export const GreeterContract = Contract.create('greeter', {
  version: '1.0.0',
  methods: {
    greet: {
      input: z.object({ name: z.string() }),
      output: z.object({ message: z.string() }),
    },
  },
});

export const greeter = defineService({
  name: 'greeter',
  kind: 'ephemeral', // holds nothing between requests — may scale to zero
  contract: GreeterContract,
  scale: { on: 'queue-depth', min: 0, max: 20 },
  expose: { http: { method: 'POST', path: '/greet', handler: 'greet' } },
});
