import type { GeneratedFile } from '../generator/index.js';
import type { Plan, PlanSummary, Resource, ResourceChange } from './types.js';

/**
 * The core diff: classify every resource path across `desired` and `actual`
 * into an add / change / destroy / no-op, producing a deterministic, path-sorted
 * {@link Plan}. Pure and free of I/O — the engine and the drift detector both
 * build on it. Equal inputs always yield byte-identical plans (so the plan is a
 * stable, reviewable, auditable artifact).
 */
export function diffState(desired: readonly Resource[], actual: readonly Resource[]): Plan {
  const desiredByPath = new Map(desired.map((res) => [res.path, res]));
  const actualByPath = new Map(actual.map((res) => [res.path, res]));

  const paths = [...new Set([...desiredByPath.keys(), ...actualByPath.keys()])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  );

  const changes: ResourceChange[] = [];
  let add = 0;
  let change = 0;
  let destroy = 0;

  for (const path of paths) {
    const want = desiredByPath.get(path);
    const have = actualByPath.get(path);

    if (want !== undefined && have === undefined) {
      changes.push({ action: 'add', path, format: want.format, after: want.content });
      add += 1;
    } else if (want === undefined && have !== undefined) {
      changes.push({ action: 'destroy', path, format: have.format, before: have.content });
      destroy += 1;
    } else if (want !== undefined && have !== undefined) {
      if (want.content === have.content) {
        changes.push({
          action: 'no-op',
          path,
          format: want.format,
          before: have.content,
          after: want.content,
        });
      } else {
        changes.push({
          action: 'change',
          path,
          format: want.format,
          before: have.content,
          after: want.content,
        });
        change += 1;
      }
    }
  }

  const summary: PlanSummary = { add, change, destroy };
  return {
    changes,
    summary,
    isNoOp: add === 0 && change === 0 && destroy === 0,
    fingerprint: planFingerprint(desired, actual),
  };
}

/**
 * Canonical, order-independent fingerprint of a resource set. Resources are
 * keyed by path and sorted, then folded into a stable hash, so two equal states
 * (regardless of input order) fingerprint identically and any content/presence
 * change shifts the hash. Pure — used both to stamp a {@link Plan} and to
 * re-check it at apply time.
 */
export function fingerprintState(resources: readonly Resource[]): string {
  const canonical = [...resources]
    .map((res) => ({ path: res.path, content: res.content, format: res.format }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return Bun.hash(JSON.stringify(canonical)).toString(16);
}

/**
 * Fingerprint of the `(desired, actual)` pair a {@link Plan} is computed from.
 * Both sides matter: the plan is invalid if either the declarations it encodes
 * or the actual state it was diffed against has changed since.
 */
export function planFingerprint(desired: readonly Resource[], actual: readonly Resource[]): string {
  return `${fingerprintState(desired)}:${fingerprintState(actual)}`;
}

/**
 * Bridge the generator's desired-state output ({@link GeneratedFile}[]) into the
 * reconciler's {@link Resource}[] — the desired side of a diff. A `GeneratedFile`
 * is already shaped like a `Resource` (path/content/format); this makes the
 * Generator → Desired State → Plan/Diff seam explicit.
 */
export function toResources(files: readonly GeneratedFile[]): readonly Resource[] {
  return files.map((file) => ({ path: file.path, content: file.content, format: file.format }));
}
