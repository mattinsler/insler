import starlight from '@astrojs/starlight';
import { project, projectStarlightConfig } from '@insler/theme';
import { defineConfig } from 'astro/config';

// The rpc subsystem docs site at rpc.insler.dev (ADR-0003 move 3,
// subsystem-branding issue 0004). The site's identity — URL, title, tagline —
// derives from the shared project data and the look comes from @insler/theme,
// so replicating this site for another subsystem (issues 0007-0010) is a
// one-line id change plus content.
const SUBSYSTEM_ID = 'rpc';
const subsystem = project.subsystems.find((s) => s.id === SUBSYSTEM_ID);
if (!subsystem) throw new Error(`${SUBSYSTEM_ID} is missing from the project identity`);

const theme = projectStarlightConfig({ hue: subsystem.hue });

export default defineConfig({
  site: subsystem.url,
  integrations: [
    starlight({
      title: subsystem.title,
      description: subsystem.tagline,
      customCss: [...theme.customCss],
      components: { ...theme.components },
      head: [...theme.head],
      // The design system's Cobalt code theme (dark in both site themes).
      expressiveCode: {
        themes: [...theme.expressiveCode.themes],
        styleOverrides: { ...theme.expressiveCode.styleOverrides },
      },
      // Starlight's built-in Pagefind full-text search stays enabled (unlike
      // the apex, which is a single homepage with nothing to search).
      sidebar: [
        { label: 'Getting started', slug: 'getting-started' },
        { label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
      ],
    }),
  ],
});
