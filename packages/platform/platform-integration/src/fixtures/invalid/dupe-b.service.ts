// The other half of the invalid fleet — same declared service name as
// dupe-a.service.ts.
import { Contract } from '@insler/rpc/contract';
import { defineService } from '@insler/service';
import { z } from 'zod';

const DupeContractB = Contract.create('dupe-b', {
  version: '1.0.0',
  methods: {
    ping: {
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
    },
  },
});

export const dupeB = defineService({
  name: 'dupe',
  kind: 'ephemeral',
  contract: DupeContractB,
});
