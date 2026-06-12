#!/usr/bin/env bash
set -euo pipefail

# Build and publish every public workspace package, then create the changeset
# git tags. Run by the Release workflow (changesets/action) on the public
# mirror; versioning happens in the private repo, so snapshots arriving here
# already carry the bumped versions.
#
# Per-package `bun publish` (rather than `changeset publish`) because bun
# rewrites workspace:* dependency ranges to real versions at pack time.
# Versions already on the registry are skipped so re-runs are idempotent;
# any other publish failure aborts the run BEFORE tags are created, so a
# failed publish never looks like a release.

cd "$(git rev-parse --show-toplevel)"

# shellcheck source=scripts/lib/package-dirs.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/package-dirs.sh"

bun run build

published=0
skipped=0
for dir in $(insler_package_dirs); do
  if grep -q '"private"[[:space:]]*:[[:space:]]*true' "$dir/package.json"; then
    echo "-- skipping private package: $dir"
    continue
  fi
  name=$(jq -r '.name' "$dir/package.json")
  version=$(jq -r '.version' "$dir/package.json")
  if bun pm view "$name@$version" version >/dev/null 2>&1; then
    echo "-- $name@$version already published; skipping"
    skipped=$((skipped + 1))
    continue
  fi
  echo "-- publishing $name@$version"
  (cd "$dir" && bun publish)
  published=$((published + 1))
done

echo "published $published package(s), skipped $skipped already on the registry"

changeset tag
