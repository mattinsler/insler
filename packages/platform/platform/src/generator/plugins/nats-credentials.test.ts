import { describe, expect, test } from 'bun:test';

import { Contract } from '@insler/rpc/contract';
import { defineService } from '@insler/service';
import type { ServiceDef } from '@insler/service';
import { expectTypeOf } from 'expect-type';
import { z } from 'zod';

import { buildFleetManifest } from '../../fleet/index.js';
import type { FleetManifest } from '../../fleet/index.js';
import type { GeneratedFile, GeneratorOptions, GeneratorPlugin } from '../types.js';
import { natsCredentialsPlugin } from './nats-credentials.js';

// --- fixtures: real FleetManifests built from the model only (no scanner) ---

interface SvcSpec {
  readonly name: string;
  readonly methods: readonly string[];
  readonly calls?: readonly string[];
}

/**
 * Build a real, frozen `ServiceDef` from a terse spec. The contract `kind` is
 * the subject root the transport advertises on (`rpc.{contract.kind}.{method}`),
 * so the manifest derives own subjects from it. `calls` are raw subject strings
 * (always valid `CallInput`s).
 */
function svc(spec: SvcSpec): ServiceDef {
  const methods: Record<string, { input: z.ZodTypeAny; output: z.ZodTypeAny }> = {};
  for (const method of spec.methods) {
    methods[method] = { input: z.object({ x: z.string() }), output: z.object({ y: z.string() }) };
  }
  const contract = Contract.create(spec.name, { version: '1.0.0', methods });
  return defineService({
    name: spec.name,
    kind: 'persistent',
    contract,
    calls: [...(spec.calls ?? [])],
  });
}

function manifestOf(...specs: readonly SvcSpec[]): FleetManifest {
  const scanned = specs.map((spec) => ({
    service: svc(spec),
    file: `/virtual/${spec.name}.def.ts`,
  }));
  const result = buildFleetManifest(scanned);
  if (result.manifest === undefined) {
    throw new Error(`fixture manifest invalid: ${JSON.stringify(result.errors)}`);
  }
  return result.manifest;
}

const OPTIONS: GeneratorOptions = {
  target: 'kubernetes',
  outputDir: '/unused',
  environment: 'prod',
};

/** Parse the single JSON authorization document the plugin emits. */
interface NatsUser {
  readonly user: string;
  readonly identity: string;
  readonly queue: string;
  readonly permissions: {
    readonly publish: { readonly allow: readonly string[] };
    readonly subscribe: { readonly allow: readonly string[] };
  };
}
interface NatsAuthDoc {
  readonly environment: string;
  readonly authorization: { readonly users: readonly NatsUser[] };
}

function authDoc(files: readonly GeneratedFile[]): NatsAuthDoc {
  expect(files.length).toBe(1);
  const file = files[0]!;
  return JSON.parse(file.content) as NatsAuthDoc;
}

function userFor(doc: NatsAuthDoc, identity: string): NatsUser {
  const user = doc.authorization.users.find((u) => u.identity === identity);
  if (user === undefined) {
    throw new Error(`no user for identity '${identity}' in ${JSON.stringify(doc)}`);
  }
  return user;
}

describe('natsCredentialsPlugin', () => {
  // AC6 — the plugin conforms to GeneratorPlugin (engine-compatible).
  test('is a GeneratorPlugin with a stable name', () => {
    expectTypeOf(natsCredentialsPlugin).toMatchTypeOf<GeneratorPlugin>();
    expect(natsCredentialsPlugin.name).toBe('nats-credentials');
  });

  // AC1 — produces NATS credential/authorization config per service.
  test('AC1: emits an authorization document with one user per service', () => {
    const manifest = manifestOf(
      { name: 'orders', methods: ['create'] },
      { name: 'checkout', methods: ['start'], calls: ['orders.create'] }
    );
    const doc = authDoc(natsCredentialsPlugin.generate(manifest, OPTIONS));
    expect(doc.authorization.users.length).toBe(2);
    expect(doc.authorization.users.map((u) => u.user).sort()).toEqual([
      'prod.default.checkout',
      'prod.default.orders',
    ]);
  });

  // AC3 — subscribe permissions derived from the service's own contract subjects.
  test('AC3: subscribe perms are the service own contract subjects (rpc.{kind}.{method})', () => {
    const manifest = manifestOf({ name: 'agent.session', methods: ['open', 'close'] });
    const doc = authDoc(natsCredentialsPlugin.generate(manifest, OPTIONS));
    const user = userFor(doc, 'prod.agent.session');
    expect(user.permissions.subscribe.allow).toContain('rpc.agent.session.open');
    expect(user.permissions.subscribe.allow).toContain('rpc.agent.session.close');
  });

  // AC2 — publish permissions derived from `calls` declarations.
  test('AC2: publish perms are the rpc subjects the service calls', () => {
    const manifest = manifestOf(
      { name: 'orders', methods: ['create'] },
      { name: 'checkout', methods: ['start'], calls: ['orders.create'] }
    );
    const doc = authDoc(natsCredentialsPlugin.generate(manifest, OPTIONS));
    const checkout = userFor(doc, 'prod.default.checkout');
    expect(checkout.permissions.publish.allow).toContain('rpc.orders.create');
  });

  // AC4 — reply inbox permissions included on BOTH publish and subscribe.
  test('AC4: reply inbox (_INBOX.>) is allowed on publish and subscribe', () => {
    const manifest = manifestOf(
      { name: 'orders', methods: ['create'] },
      { name: 'checkout', methods: ['start'], calls: ['orders.create'] }
    );
    const doc = authDoc(natsCredentialsPlugin.generate(manifest, OPTIONS));
    for (const user of doc.authorization.users) {
      expect(user.permissions.publish.allow).toContain('_INBOX.>');
      expect(user.permissions.subscribe.allow).toContain('_INBOX.>');
    }
  });

  // AC5 / AC7 — least privilege: a pure producer that calls nothing may publish
  // ONLY to its reply inbox, and subscribes ONLY to its own subjects.
  test('AC5: a producer with no calls can publish only to its reply inbox', () => {
    const manifest = manifestOf({ name: 'orders', methods: ['create'] });
    const doc = authDoc(natsCredentialsPlugin.generate(manifest, OPTIONS));
    const orders = userFor(doc, 'prod.default.orders');
    expect(orders.permissions.publish.allow).toEqual(['_INBOX.>']);
  });

  // AC7 — no service can subscribe to another service's subjects unless declared.
  test('AC7: a service may not subscribe to another service own subjects', () => {
    const manifest = manifestOf(
      { name: 'orders', methods: ['create'] },
      { name: 'checkout', methods: ['start'], calls: ['orders.create'] }
    );
    const doc = authDoc(natsCredentialsPlugin.generate(manifest, OPTIONS));
    const checkout = userFor(doc, 'prod.default.checkout');
    // checkout calls orders → may PUBLISH to rpc.orders.create, but must NOT be
    // subscribed to it (only the producer serves it).
    expect(checkout.permissions.subscribe.allow).not.toContain('rpc.orders.create');
    expect(checkout.permissions.subscribe.allow).toEqual(['_INBOX.>', 'rpc.checkout.start']);
  });

  // AC7 — calling does not grant the caller subscribe on the callee's subject.
  test('AC7: a service may not publish to a subject it did not declare a call for', () => {
    const manifest = manifestOf(
      { name: 'orders', methods: ['create'] },
      { name: 'checkout', methods: ['start'] }
    );
    const doc = authDoc(natsCredentialsPlugin.generate(manifest, OPTIONS));
    const checkout = userFor(doc, 'prod.default.checkout');
    expect(checkout.permissions.publish.allow).not.toContain('rpc.orders.create');
  });

  // Scoping — the user/identity is the derived ServiceIdentity.qualifiedName.
  test('AC5: user is scoped to the derived service identity', () => {
    const manifest = manifestOf({ name: 'agent.session', methods: ['open'] });
    const doc = authDoc(natsCredentialsPlugin.generate(manifest, OPTIONS));
    const user = userFor(doc, 'prod.agent.session');
    expect(user.user).toBe('prod.agent.session');
    expect(user.identity).toBe('prod.agent.session');
  });

  // Queue group = service name (for load balancing across replicas).
  test('queue group is the service name', () => {
    const manifest = manifestOf({ name: 'agent.session', methods: ['open'] });
    const doc = authDoc(natsCredentialsPlugin.generate(manifest, OPTIONS));
    expect(userFor(doc, 'prod.agent.session').queue).toBe('agent.session');
  });

  // AC6 — output format & file metadata are NATS-authorization compatible JSON.
  test('AC6: emits a single JSON file flagged json', () => {
    const manifest = manifestOf({ name: 'orders', methods: ['create'] });
    const files = natsCredentialsPlugin.generate(manifest, OPTIONS);
    expect(files.length).toBe(1);
    expect(files[0]!.path).toBe('nats/credentials.json');
    expect(files[0]!.format).toBe('json');
  });

  // Identity scoping reflects the run environment (dev vs prod tokens).
  test('AC5: environment qualifies the identity', () => {
    const manifest = manifestOf({ name: 'orders', methods: ['create'] });
    const doc = authDoc(
      natsCredentialsPlugin.generate(manifest, { ...OPTIONS, environment: 'dev' })
    );
    expect(doc.environment).toBe('dev');
    expect(doc.authorization.users[0]!.user).toBe('dev.default.orders');
  });

  // Determinism (PRD/Notes) — same manifest + options ⇒ byte-identical output,
  // and users/permission lists are sorted regardless of declaration order.
  test('deterministic: identical inputs yield identical content', () => {
    const a = manifestOf(
      { name: 'orders', methods: ['create', 'cancel'] },
      { name: 'checkout', methods: ['start'], calls: ['orders.create', 'orders.cancel'] }
    );
    const b = manifestOf(
      { name: 'orders', methods: ['create', 'cancel'] },
      { name: 'checkout', methods: ['start'], calls: ['orders.create', 'orders.cancel'] }
    );
    const fa = natsCredentialsPlugin.generate(a, OPTIONS);
    const fb = natsCredentialsPlugin.generate(b, OPTIONS);
    expect(fa[0]!.content).toBe(fb[0]!.content);
  });

  test('deterministic: declaration order does not change output', () => {
    const forward = manifestOf(
      { name: 'orders', methods: ['create'] },
      { name: 'checkout', methods: ['start'], calls: ['orders.create'] }
    );
    const reversed = manifestOf(
      { name: 'checkout', methods: ['start'], calls: ['orders.create'] },
      { name: 'orders', methods: ['create'] }
    );
    expect(natsCredentialsPlugin.generate(forward, OPTIONS)[0]!.content).toBe(
      natsCredentialsPlugin.generate(reversed, OPTIONS)[0]!.content
    );
  });

  test('deterministic: permission lists are sorted', () => {
    const manifest = manifestOf({ name: 'orders', methods: ['create', 'cancel', 'amend'] });
    const doc = authDoc(natsCredentialsPlugin.generate(manifest, OPTIONS));
    const subs = userFor(doc, 'prod.default.orders').permissions.subscribe.allow;
    expect([...subs]).toEqual([...subs].sort());
  });

  // Empty fleet — a valid manifest with no services emits an empty user set,
  // still a well-formed authorization document.
  test('empty fleet emits an empty user list', () => {
    const manifest = manifestOf();
    const doc = authDoc(natsCredentialsPlugin.generate(manifest, OPTIONS));
    expect(doc.authorization.users).toEqual([]);
  });
});
