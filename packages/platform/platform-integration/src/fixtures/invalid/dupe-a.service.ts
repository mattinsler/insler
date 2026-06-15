// Half of an invalid fleet: two files declare a service named `dupe`, so a
// scan must fail the cross-service name-uniqueness rule with both file
// locations on the error.
import { Contract } from '@insler/rpc/contract';
import { defineService } from '@insler/service';
import { z } from 'zod';

const DupeContractA = Contract.create('dupe-a', {
  version: '1.0.0',
  methods: {
    ping: {
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
    },
  },
});

export const dupeA = defineService({
  name: 'dupe',
  kind: 'ephemeral',
  contract: DupeContractA,
});
