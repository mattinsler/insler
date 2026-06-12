import { describe, expect, test } from 'bun:test';

import { expectTypeOf } from 'expect-type';

import { family, type FamilyBrand, type SubsystemBrand } from './family.js';

// The family identity the theme exposes (subsystem-branding issue 0001): the
// apex insler.dev plus one entry per subsystem, each linking out to its
// <subsystem>.insler.dev site. Consumed by the apex homepage and (as the
// rollout reaches them) every subsystem site's family nav.

const SUBSYSTEMS = ['di', 'platform', 'rpc', 'serde', 'service'];

describe('family identity', () => {
  test('the apex is insler.dev', () => {
    expect(family.url).toBe('https://insler.dev');
    expect(family.title).toBe('insler.dev');
  });

  test('describes exactly the five subsystems', () => {
    expect(family.subsystems.map((s) => s.id).sort()).toEqual(SUBSYSTEMS);
  });

  test('each subsystem links out to its <subsystem>.insler.dev site', () => {
    for (const s of family.subsystems) {
      expect(s.url).toBe(`https://${s.id}.insler.dev`);
    }
  });

  test('the rpc entry points at the live rpc docs site (subsystem-branding issue 0004)', () => {
    // The apex homepage renders its subsystem links from this data
    // (scripts/website-packages.test.ts pins that), so this single entry is
    // what makes the apex's rpc link target rpc.insler.dev.
    const rpc = family.subsystems.find((s) => s.id === 'rpc');
    expect(rpc?.url).toBe('https://rpc.insler.dev');
  });

  test('the di entry points at the live di docs site (subsystem-branding issue 0007)', () => {
    // The apex homepage renders its subsystem links from this data, so this
    // single entry is what makes the family homepage's di link target the di
    // subsystem site.
    const di = family.subsystems.find((s) => s.id === 'di');
    expect(di?.url).toBe('https://di.insler.dev');
  });

  test('the serde entry points at the live serde docs site (subsystem-branding issue 0008)', () => {
    // The apex homepage renders its subsystem links from this data, so this
    // single entry is what makes the family homepage's serde link target the
    // serde subsystem site.
    const serde = family.subsystems.find((s) => s.id === 'serde');
    expect(serde?.url).toBe('https://serde.insler.dev');
  });

  test('the service entry points at the live service docs site (subsystem-branding issue 0009)', () => {
    // The apex homepage renders its subsystem links from this data, so this
    // single entry is what makes the family homepage's service link target
    // the service subsystem site.
    const service = family.subsystems.find((s) => s.id === 'service');
    expect(service?.url).toBe('https://service.insler.dev');
  });

  test('each subsystem carries a displayable title and a one-line tagline', () => {
    for (const s of family.subsystems) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.tagline.length).toBeGreaterThan(0);
      expect(s.tagline).not.toContain('\n');
    }
  });

  test('type surface: the identity is read-only brand data', () => {
    expectTypeOf(family).toEqualTypeOf<FamilyBrand>();
    expectTypeOf(family.subsystems).toEqualTypeOf<readonly SubsystemBrand[]>();
    // @ts-expect-error the brand is immutable — a brand change is an edit to the theme, not a mutation
    family.title = 'other';
  });
});
