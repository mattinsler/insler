import { Contract } from '@insler/rpc/contract';
import { defineService } from '@insler/service';
import type { ServiceDef } from '@insler/service';
import { z } from 'zod';

const TwoContract = Contract.create('two', {
  version: '1.0.0',
  methods: { go: { input: z.void(), output: z.void() } },
});

// Same exposed route `(GET, /shared)` as one.def.ts — a fleet-wide route
// collision (AC4, AC6).
export const two: ServiceDef = defineService({
  name: 'two',
  kind: 'ephemeral',
  contract: TwoContract,
  expose: { http: { method: 'GET', path: '/shared' } },
});
