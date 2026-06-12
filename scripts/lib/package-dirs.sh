# Shared package discovery for the publish pipelines (scripts/ci-publish.sh
# and mirror-scripts/publish-local.sh). Lives under scripts/ because
# mirror-scripts/ is stripped from public-mirror snapshots and the mirror's CI
# executes ci-publish.sh.
#
# Emits every workspace package directory (trailing slash, relative to the
# repo root) at the nested subsystem depth (packages/<subsystem>/<pkg>) —
# any subsystem directory, including future ones, with no config change.
# Only directories that actually carry a package.json count — subsystem dirs
# and package-internal dirs (src/, coverage/, node_modules/) are never
# emitted.

insler_package_dirs() {
  local dir
  for dir in packages/*/*/; do
    [[ -f "$dir/package.json" ]] || continue
    printf '%s\n' "$dir"
  done
}
