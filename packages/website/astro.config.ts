import starlight from '@astrojs/starlight';
import { family, familyStarlightConfig } from '@insler/theme';
import { defineConfig } from 'astro/config';

// The apex insler.dev site: the family homepage. It carries the shared
// identity from @insler/theme and hosts no per-subsystem docs — those live at
// each <subsystem>.insler.dev site (ADR-0003 move 3).
const theme = familyStarlightConfig();

export default defineConfig({
  site: family.url,
  integrations: [
    starlight({
      title: family.title,
      description: family.tagline,
      customCss: [...theme.customCss],
      components: { ...theme.components },
      // The apex is a single homepage; there are no docs to search.
      pagefind: false,
    }),
  ],
});
