import starlight from '@astrojs/starlight';
import { family, familyStarlightConfig } from '@insler/theme';
import { defineConfig } from 'astro/config';

// The service subsystem docs site at service.insler.dev (ADR-0003 move 3,
// subsystem-branding issue 0009, replicating the rpc template and the
// di/serde replications). The site's identity — URL, title, tagline —
// derives from the shared family data and the look comes from @insler/theme,
// so this config is the rpc template with a one-line id change; everything
// service-specific lives in the content.
const SUBSYSTEM_ID = 'service';
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
