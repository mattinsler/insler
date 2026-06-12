# @insler/di-website — the di.insler.dev docs site

The di subsystem's docs site (ADR-0003 move 3, subsystem-branding issue
0007): an independent Astro/Starlight site carrying the shared identity from
[`@insler/theme`](../../website/theme/README.md) — family nav back to
[insler.dev](https://insler.dev) — with Starlight's built-in Pagefind
full-text search. A replication of the rpc template site: the site identity
(URL, title, tagline) derives from the theme's family data, and the reference
section carries one page per umbrella entrypoint and per adapter package
(`scripts/di-website-package.test.ts` derives that requirement from the
umbrella manifest, so it cannot drift — for di that is exactly one page,
`@insler/di`, the single-entrypoint core of a subsystem with no adapters).

Private workspace package — never published to npm, outside the changesets
release flow; it is *deployed*, not released.

## Content

- `src/content/docs/index.mdx` — landing page, opening with the 0-to-value
  story (one install, working typed container with managed cleanup).
- `src/content/docs/getting-started.md` — the guide from `bun add` to a
  working container: tokens, provide, managed, singleton, factories.
- `src/content/docs/reference/` — one page per `@insler/di` entrypoint
  (the root is the only one), seeded from the agent library guide.

## Develop

```sh
bun run --filter '@insler/di-website' dev     # local dev server
bun run --filter '@insler/di-website' build   # static build to dist/ (the build is the test)
```

## CI / deploy

`.github/workflows/di-website.yml` is path-filtered to `packages/di/**`
plus the shared theme: every PR touching them must build cleanly; preview
deploys run on PRs and production deploys to di.insler.dev run on
default-branch pushes via Cloudflare Pages (project `di-insler-dev`). The
deploy steps are inert (build-only) until the `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID` secrets are provisioned (subsystem-branding issue
0002, along with the one-time Cloudflare project + DNS setup for the
subdomain).
