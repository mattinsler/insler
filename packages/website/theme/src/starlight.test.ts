import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { familyStarlightConfig } from './starlight.js';

// The Starlight consumption surface: one `familyStarlightConfig()` call gives
// a site the family identity (tokens + header/footer carrying the family
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

describe('familyStarlightConfig', () => {
  const config = familyStarlightConfig();

  test('applies the brand tokens stylesheet', () => {
    expect(config.customCss).toContain('@insler/theme/tokens.css');
  });

  test('overrides the header and footer with the family components', () => {
    expect(config.components['Header']).toBe('@insler/theme/components/FamilyHeader.astro');
    expect(config.components['Footer']).toBe('@insler/theme/components/FamilyFooter.astro');
  });

  test('every specifier resolves to a real file via the package exports', async () => {
    const specifiers = [...config.customCss, ...Object.values(config.components)];
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      const target = resolveExport(specifier);
      expect(await Bun.file(join(pkgRoot, target)).exists()).toBe(true);
    }
  });

  test('the family nav component exists and renders from the shared family data', async () => {
    const nav = Bun.file(join(pkgRoot, resolveExport('@insler/theme/components/FamilyNav.astro')));
    expect(await nav.exists()).toBe(true);
    expect(await nav.text()).toContain('family.subsystems');
  });
});
