import { Contract } from '@insler/rpc/contract';
import { defineService } from '@insler/service';
import type { ServiceDef } from '@insler/service';
import { z } from 'zod';

const BContract = Contract.create('beta', {
  version: '1.0.0',
  methods: { ping: { input: z.void(), output: z.void() } },
});

// Same `name` as a.def.ts — must be reported as a duplicate-service-name with
// both files' locations (AC3, AC6).
export const b: ServiceDef = defineService({
  name: 'collision',
  kind: 'ephemeral',
  contract: BContract,
});
