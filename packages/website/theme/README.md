# @insler/theme

The shared insler.dev project identity — brand tokens, Starlight header/footer
overrides, and the project nav — consumed by the apex site and every subsystem
Starlight site (jdx.dev-style: shared theme, independent sites; ADR-0003
move 3).

Private workspace package: shipped as source (no build), never published to
npm, outside the changesets release flow.

## Surface

| Export | What it is |
| --- | --- |
| `@insler/theme` | `project` (the identity as data: apex + one entry per subsystem with its `<subsystem>.insler.dev` URL and accent hue) and `projectStarlightConfig({ hue })` |
| `@insler/theme/tokens.css` | The brand tokens — **the** place the visual identity is defined; a brand change is one edit here |
| `@insler/theme/components/*` | `ProjectHead.astro` (loads the brand fonts), `ProjectHeader.astro` / `ProjectFooter.astro` (Starlight `Header`/`Footer` overrides), and `ProjectNav.astro` |

## Usage (any project Starlight site)

```ts
// astro.config.ts
import starlight from '@astrojs/starlight';
import { project, projectStarlightConfig } from '@insler/theme';
import { defineConfig } from 'astro/config';

// Pass the site's accent hue (the design system's accent law rotates only the
// hue per subsystem); omit it on the apex to wear the project root hue.
const theme = projectStarlightConfig({ hue: project.hue });

export default defineConfig({
  integrations: [
    starlight({
      title: project.title,
      customCss: [...theme.customCss],
      components: { ...theme.components },
      head: [...theme.head],
    }),
  ],
});
```

Adding, renaming, or re-pitching a subsystem is an edit to `src/project.ts`;
restyling the project is an edit to `src/tokens.css`. Every consuming site
picks both up on its next build.
