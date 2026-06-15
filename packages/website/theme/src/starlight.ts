// The Starlight consumption surface: spread `projectStarlightConfig({ hue })`
// into a site's `starlight({ ... })` options to pick up the project identity —
// the brand tokens, the design-system typefaces (a Head override), the
// header/footer overrides carrying the project nav, and the site's accent hue.
// Typed structurally (specifier strings + plain head tags) so the theme itself
// stays dependency-free.

import { cobaltCodeTheme, type CodeTheme } from './cobalt.js';
import { project } from './project.js';

/** A Starlight `head` tag entry — kept structural to avoid a hard dependency.
 *  `tag` mirrors the element names Starlight's `head` config accepts, so a site
 *  can spread these straight into `starlight({ head })` without a type cast. */
export interface ProjectHeadTag {
  readonly tag: 'title' | 'base' | 'link' | 'style' | 'meta' | 'script' | 'noscript' | 'template';
  readonly attrs?: Readonly<Record<string, string | boolean | undefined>>;
  readonly content?: string;
}

/** Expressive Code options carrying the design system's code styling. A single
 *  dark theme keeps code panels dark in both the light and dark site themes. */
export interface ProjectExpressiveCode {
  readonly themes: readonly CodeTheme[];
  /** Core Expressive Code style settings (all string-valued, so the config is
   *  assignable to Starlight's `expressiveCode.styleOverrides`). */
  readonly styleOverrides: {
    readonly borderRadius: string;
    readonly borderColor: string;
    readonly codeBackground: string;
  };
}

export interface ProjectStarlightTheme {
  /** Stylesheets Starlight should load — the brand tokens. */
  readonly customCss: readonly string[];
  /** Starlight component overrides (Head/Header/Footer) carrying the brand fonts and project nav. */
  readonly components: Readonly<Record<string, string>>;
  /** Extra `<head>` tags — pins this site's accent hue for the OKLCH accent law. */
  readonly head: readonly ProjectHeadTag[];
  /** Expressive Code config — the Cobalt code theme, dark in both site themes. */
  readonly expressiveCode: ProjectExpressiveCode;
}

export interface ProjectStarlightOptions {
  /**
   * The site's accent hue (OKLCH H, degrees) — di's amber (the project root)
   * by default. Subsystem sites pass their own `subsystem.hue`; the accent law
   * in tokens.css derives every accent-colored surface from it.
   */
  readonly hue?: number;
}

export function projectStarlightConfig(
  options: ProjectStarlightOptions = {}
): ProjectStarlightTheme {
  const hue = options.hue ?? project.hue;
  return {
    customCss: ['@insler/theme/tokens.css'],
    components: {
      Head: '@insler/theme/components/ProjectHead.astro',
      Header: '@insler/theme/components/ProjectHeader.astro',
      Footer: '@insler/theme/components/ProjectFooter.astro',
    },
    // Set the accent hue once, on :root. tokens.css only ever reads --if-hue
    // (with the root hue as fallback), so this is the single source that
    // selects the site's accent — independent of stylesheet load order.
    head: [{ tag: 'style', content: `:root{--if-hue:${hue};}` }],
    // The design system's Cobalt code theme — one dark theme, so code panels
    // stay dark (recessed) in both the light and dark site themes. The frame is
    // pared back to a flat, hairline-bordered panel to match the design system.
    expressiveCode: {
      themes: [cobaltCodeTheme],
      styleOverrides: {
        borderRadius: '11px',
        borderColor: 'var(--if-line)',
        codeBackground: '#080b14',
      },
    },
  };
}
