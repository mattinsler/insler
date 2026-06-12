# @insler/rpc-website — the rpc.insler.dev docs site

The rpc subsystem's docs site (ADR-0003 move 3): an independent
Astro/Starlight site carrying the shared identity from
[`@insler/theme`](../../website/theme/README.md) — family nav back to
[insler.dev](https://insler.dev) — with Starlight's built-in Pagefind
full-text search. The first subsystem site, and the template the remaining
subsystems (issues 0007–0010) replicate: the site identity (URL, title,
tagline) derives from the theme's family data, and the reference section
carries one page per umbrella entrypoint and per adapter package
(`scripts/rpc-website-package.test.ts` derives that requirement from the
umbrella manifest, so it cannot drift).

Private workspace package — never published to npm, outside the changesets
release flow; it is *deployed*, not released.

## Content

- `src/content/docs/index.mdx` — landing page, opening with the 0-to-value
  story (one install, working in-process service).
- `src/content/docs/getting-started.md` — the guide from `bun add` to a
  working service.
- `src/content/docs/reference/` — one page per `@insler/rpc` subpath
  entrypoint and per adapter package, seeded from the agent library guides.

## Develop

```sh
bun run --filter '@insler/rpc-website' dev     # local dev server
bun run --filter '@insler/rpc-website' build   # static build to dist/ (the build is the test)
```

## CI / deploy

`.github/workflows/rpc-website.yml` is path-filtered to `packages/rpc/**`
plus the shared theme: every PR touching them must build cleanly; preview
deploys run on PRs and production deploys to rpc.insler.dev run on
default-branch pushes via Cloudflare Pages (project `rpc-insler-dev`). The
deploy steps are inert (build-only) until the `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID` secrets are provisioned (subsystem-branding issue
0002, along with the one-time Cloudflare project + DNS setup for the
subdomain).
