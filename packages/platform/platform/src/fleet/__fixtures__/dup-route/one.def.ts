import { Contract } from '@insler/rpc/contract';
import { defineService } from '@insler/service';
import type { ServiceDef } from '@insler/service';
import { z } from 'zod';

const OneContract = Contract.create('one', {
  version: '1.0.0',
  methods: { go: { input: z.void(), output: z.void() } },
});

export const one: ServiceDef = defineService({
  name: 'one',
  kind: 'ephemeral',
  contract: OneContract,
  expose: { http: { method: 'GET', path: '/shared' } },
});
