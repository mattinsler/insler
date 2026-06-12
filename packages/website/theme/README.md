# @insler/theme

The shared insler.dev family identity — brand tokens, Starlight header/footer
overrides, and the family nav — consumed by the apex site and every subsystem
Starlight site (jdx.dev-style: shared theme, independent sites; ADR-0003
move 3).

Private workspace package: shipped as source (no build), never published to
npm, outside the changesets release flow.

## Surface

| Export | What it is |
| --- | --- |
| `@insler/theme` | `family` (the identity as data: apex + one entry per subsystem with its `<subsystem>.insler.dev` URL) and `familyStarlightConfig()` |
| `@insler/theme/tokens.css` | The brand tokens — **the** place the visual identity is defined; a brand change is one edit here |
| `@insler/theme/components/*` | `FamilyHeader.astro` / `FamilyFooter.astro` (Starlight `Header`/`Footer` overrides) and `FamilyNav.astro` |

## Usage (any family Starlight site)

```ts
// astro.config.ts
import starlight from '@astrojs/starlight';
import { family, familyStarlightConfig } from '@insler/theme';
import { defineConfig } from 'astro/config';

const theme = familyStarlightConfig();

export default defineConfig({
  integrations: [
    starlight({
      title: family.title,
      customCss: [...theme.customCss],
      components: { ...theme.components },
    }),
  ],
});
```

Adding, renaming, or re-pitching a subsystem is an edit to `src/family.ts`;
restyling the family is an edit to `src/tokens.css`. Every consuming site
picks both up on its next build.
