// The insler.dev family identity, as data. The apex homepage and every
// subsystem site's family nav render from this single definition — adding,
// renaming, or re-pitching a subsystem is one edit here.

export interface SubsystemBrand {
  /** Directory + subdomain id: `packages/<id>/`, `<id>.insler.dev`. */
  readonly id: string;
  /** The subsystem's umbrella npm package. */
  readonly package: string;
  /** Display title. */
  readonly title: string;
  /** One-line pitch shown on the family homepage and nav. */
  readonly tagline: string;
  /** The subsystem's own docs site. */
  readonly url: string;
}

export interface FamilyBrand {
  readonly title: string;
  readonly tagline: string;
  readonly url: string;
  readonly subsystems: readonly SubsystemBrand[];
}

function subsystem(id: string, tagline: string): SubsystemBrand {
  return {
    id,
    package: `@insler/${id}`,
    title: `@insler/${id}`,
    tagline,
    url: `https://${id}.insler.dev`,
  };
}

export const family: FamilyBrand = {
  title: 'insler.dev',
  tagline: 'A family of typed, contract-first TypeScript subsystems for building services.',
  url: 'https://insler.dev',
  subsystems: [
    subsystem('rpc', 'Contract-first RPC: typed contracts, clients, hosts, and transports.'),
    subsystem('di', 'A typed dependency-injection container with managed lifecycles.'),
    subsystem('serde', 'Pluggable wire serialization: JSON, MessagePack, CBOR, and Avro.'),
    subsystem('service', 'Environment-aware services and deployment-intent declarations.'),
    subsystem(
      'platform',
      'Codegen and reconciliation from service declarations to running fleets.'
    ),
  ],
};
