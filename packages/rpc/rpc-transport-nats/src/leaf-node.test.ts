import { describe, expect, test } from 'bun:test';

import { expectTypeOf } from 'expect-type';

import {
  buildLeafNodeServerConfig,
  type LeafNodeConfig,
  type LeafNodeRemote,
  type LeafNodeServerConfig,
  renderLeafNodeServerConfig,
} from './leaf-node.js';

// --------------------------------------------------------------------------
// AC1 / AC6: a leaf node joins the dev cluster from config alone — just a
// nats-server process (no Docker, no K8s). The config builder is the wire
// contract that "connect to the dev cluster" compiles down to.
// --------------------------------------------------------------------------

describe('buildLeafNodeServerConfig', () => {
  test('AC1: builds a leaf-node config soliciting a route to the dev-cluster remote', () => {
    const config = buildLeafNodeServerConfig({
      remotes: [{ url: 'nats-leaf://dev-cluster:7422' }],
    });

    expect(config.leafnodes.remotes).toEqual([{ url: 'nats-leaf://dev-cluster:7422' }]);
  });

  test('AC1: defaults the local client listener to a random loopback port', () => {
    const config = buildLeafNodeServerConfig({
      remotes: [{ url: 'nats-leaf://dev-cluster:7422' }],
    });

    // Loopback only, random port (-1) — the leaf is the developer's machine.
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(-1);
  });

  test('AC1: honours an explicit local client host/port', () => {
    const config = buildLeafNodeServerConfig({
      remotes: [{ url: 'nats-leaf://dev-cluster:7422' }],
      host: '0.0.0.0',
      port: 4555,
    });

    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(4555);
  });

  test('AC1: supports multiple dev-cluster remotes', () => {
    const config = buildLeafNodeServerConfig({
      remotes: [{ url: 'nats-leaf://a:7422' }, { url: 'nats-leaf://b:7422' }],
    });

    expect(config.leafnodes.remotes.map((r) => r.url)).toEqual([
      'nats-leaf://a:7422',
      'nats-leaf://b:7422',
    ]);
  });

  // --------------------------------------------------------------------------
  // AC7: credentials for the dev-cluster connection are managed by the tool —
  // threaded onto the remote, never embedded in a service.
  // --------------------------------------------------------------------------

  test('AC7: threads a tool-managed credentials file onto the remote', () => {
    const config = buildLeafNodeServerConfig({
      remotes: [{ url: 'nats-leaf://dev-cluster:7422', credentials: '/run/dev.creds' }],
    });

    expect(config.leafnodes.remotes[0]).toEqual({
      url: 'nats-leaf://dev-cluster:7422',
      credentials: '/run/dev.creds',
    });
  });

  test('AC7: omits the credentials key entirely when none is supplied', () => {
    const config = buildLeafNodeServerConfig({
      remotes: [{ url: 'nats-leaf://dev-cluster:7422' }],
    });

    expect(config.leafnodes.remotes[0]).not.toHaveProperty('credentials');
  });

  test('threads an optional account binding onto the remote', () => {
    const config = buildLeafNodeServerConfig({
      remotes: [{ url: 'nats-leaf://dev-cluster:7422', account: 'DEV' }],
    });

    expect(config.leafnodes.remotes[0]).toEqual({
      url: 'nats-leaf://dev-cluster:7422',
      account: 'DEV',
    });
  });

  test('rejects an empty remote list (a leaf with nothing to solicit never joins)', () => {
    expect(() => buildLeafNodeServerConfig({ remotes: [] })).toThrow(/at least one/i);
  });
});

// --------------------------------------------------------------------------
// AC6: the rendered config is exactly what a single nats-server process consumes
// — no orchestration layer in between.
// --------------------------------------------------------------------------

describe('renderLeafNodeServerConfig', () => {
  test('AC6: renders to text nats-server can parse (a JSON-superset config)', () => {
    const config = buildLeafNodeServerConfig({
      remotes: [{ url: 'nats-leaf://dev-cluster:7422', credentials: '/run/dev.creds' }],
    });

    const text = renderLeafNodeServerConfig(config);
    const reparsed = JSON.parse(text) as LeafNodeServerConfig;

    expect(reparsed).toEqual(config);
  });
});

// --------------------------------------------------------------------------
// Type-level contract guarantees (expect-type, enforced by `tsc --noEmit`).
// --------------------------------------------------------------------------

describe('leaf-node types', () => {
  test('LeafNodeRemote.url is required; credentials/account are optional strings', () => {
    expectTypeOf<LeafNodeRemote>().toHaveProperty('url').toEqualTypeOf<string>();
    expectTypeOf<LeafNodeRemote['credentials']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<LeafNodeRemote['account']>().toEqualTypeOf<string | undefined>();
  });

  test('LeafNodeConfig.remotes is required; host/port are optional', () => {
    expectTypeOf<LeafNodeConfig['remotes']>().toEqualTypeOf<readonly LeafNodeRemote[]>();
    expectTypeOf<LeafNodeConfig['host']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<LeafNodeConfig['port']>().toEqualTypeOf<number | undefined>();
  });

  test('a remote requires url — an entry without it does not type-check', () => {
    // @ts-expect-error a leaf-node remote must carry a url to solicit
    const _bad: LeafNodeConfig = { remotes: [{ credentials: '/run/dev.creds' }] };
    // reference to avoid unused-var lint while keeping the @ts-expect-error live
    void _bad;
  });
});
