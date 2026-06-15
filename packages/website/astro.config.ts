import { project } from '@insler/theme';
import { defineConfig } from 'astro/config';

// The apex insler.dev site: the project homepage. It is a single bespoke
// landing page (not a docs site), so it runs as plain Astro rather than
// Starlight — the per-subsystem docs sites at <subsystem>.insler.dev are the
// Starlight ones. The apex still wears the shared identity: it loads the brand
// tokens from @insler/theme (`tokens.css`, the single source of the palette)
// and renders its subsystem directory from the same `project` data the
// subsystem sites' project nav uses. The homepage carries the project root
// accent hue.
export default defineConfig({
  site: project.url,
});
