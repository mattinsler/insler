import { Contract } from '@insler/rpc/contract';
import { defineService } from '@insler/service';
import type { ServiceDef } from '@insler/service';
import { z } from 'zod';

const AContract = Contract.create('alpha', {
  version: '1.0.0',
  methods: { ping: { input: z.void(), output: z.void() } },
});

export const a: ServiceDef = defineService({
  name: 'collision',
  kind: 'ephemeral',
  contract: AContract,
});
