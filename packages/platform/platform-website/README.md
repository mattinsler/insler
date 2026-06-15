# @insler/platform-website — the platform.insler.dev docs site

The platform subsystem's docs site (ADR-0003 move 3, subsystem-branding issue
0010): an independent Astro/Starlight site carrying the shared identity from
[`@insler/theme`](../../website/theme/README.md) — project nav back to
[insler.dev](https://insler.dev) — with Starlight's built-in Pagefind
full-text search. A replication of the rpc template site: the site identity
(URL, title, tagline) derives from the theme's project data, and the reference
section carries one page per umbrella entrypoint and per published sibling
package (`scripts/platform-website-package.test.ts` derives that requirement
from the umbrella manifest, so it cannot drift — for platform that is the
three-entrypoint `@insler/platform` umbrella plus `@insler/cli`, with no
adapter packages).

Private workspace package — never published to npm, outside the changesets
release flow; it is *deployed*, not released.

## Content

- `src/content/docs/index.mdx` — landing page, opening with the 0-to-value
  story (one install, a declaration scanned into the desired-state model and
  compiled into artifacts).
- `src/content/docs/getting-started.md` — the guide from `bun add` through
  declaration → scan → generate → plan/apply, the production gate, and the
  `insler` CLI.
- `src/content/docs/reference/` — one page per umbrella entrypoint
  (`/fleet`, `/generator`, `/reconciler`) and one for `@insler/cli`, seeded
  from the agent library guide.

## Develop

```sh
bun run --filter '@insler/platform-website' dev     # local dev server
bun run --filter '@insler/platform-website' build   # static build to dist/ (the build is the test)
```

## CI / deploy

`.github/workflows/platform-website.yml` is path-filtered to the site's own
content (this package, the shared theme, and the workflow itself): every PR
touching them must build cleanly. Preview deploys run on PRs and post a
sticky preview-URL comment; production deploys to platform.insler.dev run on
default-branch pushes — and only ever from the public mirror repo
(`mattinsler/insler`) — via Cloudflare Pages (project `platform-insler-dev`).
The deploy steps are inert (build-only) until the `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID` secrets are provisioned (subsystem-branding issue
0002, along with the one-time Cloudflare project + DNS setup for the
subdomain).
