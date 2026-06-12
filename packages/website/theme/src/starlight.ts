// The Starlight consumption surface: spread `familyStarlightConfig()` into a
// site's `starlight({ ... })` options to pick up the family identity — the
// brand tokens plus header/footer overrides carrying the family nav. Typed
// structurally (specifier strings) so the theme itself stays dependency-free.

export interface FamilyStarlightTheme {
  /** Stylesheets Starlight should load — the brand tokens. */
  readonly customCss: readonly string[];
  /** Starlight component overrides (Header/Footer) carrying the family nav. */
  readonly components: Readonly<Record<string, string>>;
}

export function familyStarlightConfig(): FamilyStarlightTheme {
  return {
    customCss: ['@insler/theme/tokens.css'],
    components: {
      Header: '@insler/theme/components/FamilyHeader.astro',
      Footer: '@insler/theme/components/FamilyFooter.astro',
    },
  };
}
