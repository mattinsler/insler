import type { ServiceDef, ServiceEnv } from '@insler/service';
import { deriveIdentity } from '@insler/service';

import type { GeneratedFile, GeneratorOptions, GeneratorPlugin } from '../types.js';

/**
 * NATS credential generation (#0016).
 *
 * Emits a single, deterministic NATS authorization document granting every
 * service in the {@link import('@insler/platform/fleet').FleetManifest} a *least-privilege*
 * set of publish/subscribe permissions derived purely from its declared contract
 * surface — never from hand-authored config (US-6, US-5).
 *
 * Scope derivation, per service:
 * - **subscribe** ← the service's OWN contract subjects (`rpc.{contract.kind}.{method}`
 *   for each method it serves) plus the reply inbox `_INBOX.>`. A service is only
 *   ever subscribed to subjects it serves; it can never subscribe to another
 *   service's subjects unless it declared them (AC7).
 * - **publish** ← the subjects it `calls` (`rpc.{calledSubject}` for each `calls`
 *   entry) plus the reply inbox `_INBOX.>`. A pure producer that calls nothing
 *   may publish *only* to its reply inbox (AC5).
 * - **queue group** ← the service name, so replicas load-balance the same
 *   subscriptions (the host advertises with this queue group).
 *
 * The `user`/`identity` is the service's derived {@link ServiceIdentity}
 * `qualifiedName` (`environment.namespace.name`) — the same identity NATS
 * credential minting, secret resolution, and workload identity all key off
 * (#0004). The run's `environment` qualifies that identity.
 *
 * Output: one `nats/credentials.json` artifact whose shape mirrors the NATS
 * server `authorization { users: [ { user, permissions { publish, subscribe } } ] }`
 * model, so it maps directly onto the NATS operator/account (NKey or JWT)
 * authorization config (AC6). Pure and deterministic: users are sorted by
 * identity and every permission list is sorted, so the same manifest + options
 * always render byte-identical output.
 *
 * Boundary: this plugin imports only the `ServiceDef`/identity *model* from
 * `@insler/service` and consumes the `FleetManifest` model — it never reaches
 * for fleet's scanner or the disk.
 */

/** The NATS reply-inbox subject prefix the request/reply pattern uses. */
const REPLY_INBOX = '_INBOX.>';

/**
 * The RPC subject prefix the NATS transport advertises endpoints under
 * (`{subjectPrefix}.{service}.{method}`, default `rpc`). Own subjects and called
 * subjects are both scoped under it so credentials match the wire subjects.
 */
const SUBJECT_PREFIX = 'rpc';

/**
 * The run-level environment string (`dev`/`prod`/…) mapped back to the
 * {@link ServiceEnv} {@link deriveIdentity} expects. The short tokens the
 * generator carries are the same ones identity emits, so we accept both the
 * short token and the full name; anything unknown falls back to `production`
 * (the strict default — credentials are never relaxed implicitly).
 */
function toServiceEnv(environment: string): ServiceEnv {
  switch (environment) {
    case 'dev':
    case 'development':
      return 'development';
    case 'test':
      return 'test';
    default:
      return 'production';
  }
}

/** The set of RPC subjects a service serves: `rpc.{contract.kind}.{method}`. */
function ownSubjects(service: ServiceDef): readonly string[] {
  return service.contract.methodList.map(
    (method) => `${SUBJECT_PREFIX}.${service.contract.kind}.${method.name}`
  );
}

/** A single NATS authorization user entry — the per-service scoped credential. */
interface NatsAuthUser {
  readonly user: string;
  readonly identity: string;
  readonly queue: string;
  readonly permissions: {
    readonly publish: { readonly allow: readonly string[] };
    readonly subscribe: { readonly allow: readonly string[] };
  };
}

/** De-duplicate and sort a subject list for deterministic, minimal output. */
function uniqueSorted(subjects: readonly string[]): readonly string[] {
  return [...new Set(subjects)].sort();
}

export const natsCredentialsPlugin: GeneratorPlugin = {
  name: 'nats-credentials',
  generate(manifest, options: GeneratorOptions): readonly GeneratedFile[] {
    const env = toServiceEnv(options.environment);

    const users: NatsAuthUser[] = manifest.services.map((service) => {
      const identity = deriveIdentity(service, env);

      // Subscribe: ONLY the service's own contract subjects (+ reply inbox).
      const subscribe = uniqueSorted([...ownSubjects(service), REPLY_INBOX]);

      // Publish: ONLY the subjects the service declared it calls (+ reply inbox).
      const calls = service.calls ?? [];
      const publish = uniqueSorted([
        ...calls.map((subject) => `${SUBJECT_PREFIX}.${subject}`),
        REPLY_INBOX,
      ]);

      return {
        user: identity.qualifiedName,
        identity: identity.qualifiedName,
        queue: service.name,
        permissions: {
          publish: { allow: publish },
          subscribe: { allow: subscribe },
        },
      };
    });

    // Sort users by identity for stable, deterministic output.
    users.sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));

    const doc = {
      environment: options.environment,
      authorization: { users },
    };

    return [
      {
        path: 'nats/credentials.json',
        content: `${JSON.stringify(doc, null, 2)}\n`,
        format: 'json',
      },
    ];
  },
};
