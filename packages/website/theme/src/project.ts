// The insler.dev project identity, as data. The apex homepage and every
// subsystem site's project nav render from this single definition — adding,
// renaming, or re-pitching a subsystem is one edit here.

/** Whether a subsystem has a published package and a live docs site (`live`),
 *  or is still in design with its site forthcoming (`soon`). The apex homepage
 *  directory renders a version + DOCS link for `live` entries and a muted
 *  "soon" marker for the rest. */
export type SubsystemStatus = 'live' | 'soon';

export interface SubsystemBrand {
  /** Directory + subdomain id: `packages/<id>/`, `<id>.insler.dev`. */
  readonly id: string;
  /** The subsystem's umbrella npm package. */
  readonly package: string;
  /** Display title. */
  readonly title: string;
  /** One-line pitch shown on the project homepage and nav. */
  readonly tagline: string;
  /** The subsystem's own docs site. */
  readonly url: string;
  /**
   * The subsystem's accent hue (OKLCH H, degrees). The design system's accent
   * law freezes lightness and chroma and rotates only the hue per subsystem,
   * so six unrelated hues read as one set at equal weight.
   */
  readonly hue: number;
  /** Shipped (`live`) or forthcoming (`soon`); drives the homepage directory. */
  readonly status: SubsystemStatus;
  /** Current published version, e.g. `v0.1.0`. Present for `live` subsystems. */
  readonly version?: string;
}

export interface ProjectBrand {
  readonly title: string;
  readonly tagline: string;
  readonly url: string;
  /** The apex/root accent hue (OKLCH H) — the project carries di's amber. */
  readonly hue: number;
  readonly subsystems: readonly SubsystemBrand[];
}

function subsystem(
  id: string,
  hue: number,
  tagline: string,
  status: SubsystemStatus,
  version?: string
): SubsystemBrand {
  return {
    id,
    package: `@insler/${id}`,
    title: `@insler/${id}`,
    tagline,
    url: `https://${id}.insler.dev`,
    hue,
    status,
    version,
  };
}

export const project: ProjectBrand = {
  title: 'insler.dev',
  tagline: 'A set of typed, contract-first TypeScript subsystems for building services.',
  url: 'https://insler.dev',
  hue: 55,
  subsystems: [
    subsystem(
      'rpc',
      250,
      'Contract-first RPC: typed contracts, clients, hosts, and transports.',
      'live',
      'v0.1.0'
    ),
    subsystem(
      'di',
      55,
      'A typed dependency-injection container with managed lifecycles.',
      'live',
      'v0.1.0'
    ),
    subsystem(
      'serde',
      155,
      'Pluggable wire serialization: JSON, MessagePack, CBOR, and Avro.',
      'live',
      'v0.1.0'
    ),
    subsystem(
      'service',
      305,
      'Environment-aware services and deployment-intent declarations.',
      'soon'
    ),
    subsystem(
      'platform',
      200,
      'Codegen and reconciliation from service declarations to running fleets.',
      'soon'
    ),
    subsystem('workflow', 350, 'Durable, typed workflows on top of the other projects.', 'soon'),
  ],
};
