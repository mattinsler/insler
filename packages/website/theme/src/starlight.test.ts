import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { project } from './project.js';
import { projectStarlightConfig } from './starlight.js';

// The Starlight consumption surface: one `projectStarlightConfig()` call gives
// a site the project identity (tokens + header/footer carrying the project
// nav). Every specifier the config hands to Starlight must map to a real file
// through this package's exports, so a consuming site build can never dangle.

const pkgRoot = new URL('..', import.meta.url).pathname;
const manifest = await Bun.file(join(pkgRoot, 'package.json')).json();

function resolveExport(specifier: string): string {
  // '@insler/theme/<subpath>' -> './<subpath>' through the manifest exports map
  const subpath = `.${specifier.slice('@insler/theme'.length)}`;
  const exportsMap: Record<string, string> = manifest.exports;
  const exact = exportsMap[subpath];
  if (exact) return exact;
  for (const [pattern, target] of Object.entries(exportsMap)) {
    if (!pattern.includes('*')) continue;
    const [prefix = '', suffix = ''] = pattern.split('*');
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
      return target.replace('*', subpath.slice(prefix.length, subpath.length - suffix.length));
    }
  }
  throw new Error(`no export matches ${specifier}`);
}

describe('projectStarlightConfig', () => {
  const config = projectStarlightConfig();

  test('applies the brand tokens stylesheet', () => {
    expect(config.customCss).toContain('@insler/theme/tokens.css');
  });

  test('overrides the head, header, and footer with the project components', () => {
    expect(config.components['Head']).toBe('@insler/theme/components/ProjectHead.astro');
    expect(config.components['Header']).toBe('@insler/theme/components/ProjectHeader.astro');
    expect(config.components['Footer']).toBe('@insler/theme/components/ProjectFooter.astro');
  });

  test('every specifier resolves to a real file via the package exports', async () => {
    const specifiers = [...config.customCss, ...Object.values(config.components)];
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      const target = resolveExport(specifier);
      expect(await Bun.file(join(pkgRoot, target)).exists()).toBe(true);
    }
  });

  test('the project nav component exists and renders from the shared project data', async () => {
    const nav = Bun.file(join(pkgRoot, resolveExport('@insler/theme/components/ProjectNav.astro')));
    expect(await nav.exists()).toBe(true);
    expect(await nav.text()).toContain('project.subsystems');
  });

  test('pins the accent hue on :root via a head style tag (the accent law)', () => {
    // The hue is the one thing each site sets; tokens.css derives every
    // accent-colored surface from --if-hue. A subsystem passes its own hue.
    const rpc = projectStarlightConfig({ hue: 250 });
    const [tag] = rpc.head;
    expect(tag?.tag).toBe('style');
    expect(tag?.content).toContain('--if-hue:250');
  });

  test('defaults to the project root hue when none is given (the apex/amber)', () => {
    expect(config.head[0]?.content).toContain(`--if-hue:${project.hue}`);
  });

  test('carries one dark code theme, so code panels stay dark in both site themes', () => {
    // The design system recesses code in both the light and dark site themes.
    // Expressive Code only swaps themes when given more than one, so a single
    // dark theme keeps code panels dark throughout.
    expect(config.expressiveCode.themes).toHaveLength(1);
    expect(config.expressiveCode.themes[0]?.type).toBe('dark');
    expect(config.expressiveCode.styleOverrides.codeBackground).toMatch(/^#[0-9a-f]{6}$/);
  });
});
