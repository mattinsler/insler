import starlight from '@astrojs/starlight';
import { family, familyStarlightConfig } from '@insler/theme';
import { defineConfig } from 'astro/config';

// The di subsystem docs site at di.insler.dev (ADR-0003 move 3,
// subsystem-branding issue 0007, replicating the rpc template). The site's
// identity — URL, title, tagline — derives from the shared family data and
// the look comes from @insler/theme, so this config is the rpc template with
// a one-line id change; everything di-specific lives in the content.
const SUBSYSTEM_ID = 'di';
const subsystem = family.subsystems.find((s) => s.id === SUBSYSTEM_ID);
if (!subsystem) throw new Error(`${SUBSYSTEM_ID} is missing from the family identity`);

const theme = familyStarlightConfig();

export default defineConfig({
  site: subsystem.url,
  integrations: [
    starlight({
      title: subsystem.title,
      description: subsystem.tagline,
      customCss: [...theme.customCss],
      components: { ...theme.components },
      // Starlight's built-in Pagefind full-text search stays enabled (unlike
      // the apex, which is a single homepage with nothing to search).
      sidebar: [
        { label: 'Getting started', slug: 'getting-started' },
        { label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
      ],
    }),
  ],
});
