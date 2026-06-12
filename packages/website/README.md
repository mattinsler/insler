# @insler/website — the apex insler.dev site

The family homepage (ADR-0003 move 3): an Astro/Starlight site that carries
the shared identity from [`@insler/theme`](./theme/README.md) and describes
each subsystem with a link out to its `<subsystem>.insler.dev` site. The apex
hosts **no per-subsystem docs** — those live with their subsystem.

Private workspace package — the one explicitly-named non-subsystem workspace
entry. Never published to npm, outside the changesets release flow; it is
*deployed*, not released.

## Develop

```sh
bun run --filter '@insler/website' dev     # local dev server
bun run --filter '@insler/website' build   # static build to dist/ (the build is the test)
```

The homepage renders from the theme's `family` data
(`src/components/SubsystemGrid.astro`); it carries no identity of its own.

## CI / deploy

`.github/workflows/website.yml` is path-filtered to `packages/website/**`:
every PR touching the site or theme must build cleanly; preview deploys run
on PRs and production deploys to insler.dev run on default-branch pushes via
Cloudflare Pages (project `insler-dev`). The deploy steps are inert
(build-only) until the `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`
secrets are provisioned (subsystem-branding issue 0002, along with the
one-time Cloudflare project + DNS setup for the apex domain).
