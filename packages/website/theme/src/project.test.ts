import { describe, expect, test } from 'bun:test';

import { expectTypeOf } from 'expect-type';

import { project, type ProjectBrand, type SubsystemBrand } from './project.js';

// The project identity the theme exposes (subsystem-branding issue 0001): the
// apex insler.dev plus one entry per subsystem, each linking out to its
// <subsystem>.insler.dev site. Consumed by the apex homepage and (as the
// rollout reaches them) every subsystem site's project nav.

const SUBSYSTEMS = ['di', 'platform', 'rpc', 'serde', 'service', 'workflow'];

describe('project identity', () => {
  test('the apex is insler.dev', () => {
    expect(project.url).toBe('https://insler.dev');
    expect(project.title).toBe('insler.dev');
  });

  test('describes exactly the six subsystems', () => {
    expect(project.subsystems.map((s) => s.id).sort()).toEqual(SUBSYSTEMS);
  });

  test('each subsystem links out to its <subsystem>.insler.dev site', () => {
    for (const s of project.subsystems) {
      expect(s.url).toBe(`https://${s.id}.insler.dev`);
    }
  });

  test('the rpc entry points at the live rpc docs site (subsystem-branding issue 0004)', () => {
    // The apex homepage renders its subsystem links from this data
    // (scripts/website-packages.test.ts pins that), so this single entry is
    // what makes the apex's rpc link target rpc.insler.dev.
    const rpc = project.subsystems.find((s) => s.id === 'rpc');
    expect(rpc?.url).toBe('https://rpc.insler.dev');
  });

  test('the di entry points at the live di docs site (subsystem-branding issue 0007)', () => {
    // The apex homepage renders its subsystem links from this data, so this
    // single entry is what makes the project homepage's di link target the di
    // subsystem site.
    const di = project.subsystems.find((s) => s.id === 'di');
    expect(di?.url).toBe('https://di.insler.dev');
  });

  test('the serde entry points at the live serde docs site (subsystem-branding issue 0008)', () => {
    // The apex homepage renders its subsystem links from this data, so this
    // single entry is what makes the project homepage's serde link target the
    // serde subsystem site.
    const serde = project.subsystems.find((s) => s.id === 'serde');
    expect(serde?.url).toBe('https://serde.insler.dev');
  });

  test('the service entry points at the live service docs site (subsystem-branding issue 0009)', () => {
    // The apex homepage renders its subsystem links from this data, so this
    // single entry is what makes the project homepage's service link target
    // the service subsystem site.
    const service = project.subsystems.find((s) => s.id === 'service');
    expect(service?.url).toBe('https://service.insler.dev');
  });

  test('the platform entry points at the live platform docs site (subsystem-branding issue 0010)', () => {
    // The apex homepage renders its subsystem links from this data, so this
    // single entry is what makes the project homepage's platform link target
    // the platform subsystem site.
    const platform = project.subsystems.find((s) => s.id === 'platform');
    expect(platform?.url).toBe('https://platform.insler.dev');
  });

  test('the workflow entry points at its (forthcoming) docs site', () => {
    // workflow is the sixth subsystem from the design system's subdomain set;
    // its site is forthcoming, but the project identity already links it out.
    const workflow = project.subsystems.find((s) => s.id === 'workflow');
    expect(workflow?.url).toBe('https://workflow.insler.dev');
  });

  test('each subsystem carries a displayable title and a one-line tagline', () => {
    for (const s of project.subsystems) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.tagline.length).toBeGreaterThan(0);
      expect(s.tagline).not.toContain('\n');
    }
  });

  test('each subsystem carries a distinct accent hue, and the apex wears di amber', () => {
    // The design system's accent law: lightness and chroma are frozen, only the
    // hue rotates per subsystem. The apex/root hue is di's amber.
    const hues = project.subsystems.map((s) => s.hue);
    for (const hue of hues) {
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
    expect(new Set(hues).size).toBe(hues.length);
    const di = project.subsystems.find((s) => s.id === 'di');
    expect(di).toBeDefined();
    expect(project.hue).toBe(di!.hue);
  });

  test('type surface: the identity is read-only brand data', () => {
    expectTypeOf(project).toEqualTypeOf<ProjectBrand>();
    expectTypeOf(project.subsystems).toEqualTypeOf<readonly SubsystemBrand[]>();
    // @ts-expect-error the brand is immutable — a brand change is an edit to the theme, not a mutation
    project.title = 'other';
  });
});
