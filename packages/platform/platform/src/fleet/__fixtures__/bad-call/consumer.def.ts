import { Contract } from '@insler/rpc/contract';
import { defineService } from '@insler/service';
import type { ServiceDef } from '@insler/service';
import { z } from 'zod';

const ConsumerContract = Contract.create('consumer', {
  version: '1.0.0',
  methods: { run: { input: z.void(), output: z.void() } },
});

// Calls `ghost.method`, which no scanned service serves — an
// unknown-call-subject error with this file's location (AC6).
export const consumer: ServiceDef = defineService({
  name: 'consumer',
  kind: 'ephemeral',
  contract: ConsumerContract,
  calls: ['ghost.method'],
});
