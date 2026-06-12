import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Package discovery for the shared build config (tsdown.config.ts). tsdown's
// own workspace globs match directories without checking for a package.json
// (a raw `packages/*/*` would also match non-package dirs), so the build
// config discovers package directories itself: every directory carrying a
// package.json at the nested subsystem depth
// (`packages/<subsystem>/<pkg>`) — any subsystem directory, including future
// ones, with no config change.

function isPackageDir(root: string, rel: string): boolean {
  return existsSync(join(root, rel, 'package.json'));
}

function subdirs(root: string, rel: string): string[] {
  return readdirSync(join(root, rel), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
    .map((entry) => `${rel}/${entry.name}`);
}

export function discoverWorkspacePackages(rootDir: string): string[] {
  const found: string[] = [];
  for (const subsystem of subdirs(rootDir, 'packages')) {
    for (const nested of subdirs(rootDir, subsystem)) {
      if (isPackageDir(rootDir, nested)) found.push(nested);
    }
  }
  return found;
}

// The build-config variant: private packages (website/integration packages
// per ADR-0003 move 3) join the workspace but are never tsdown-built or
// published — they build with their own toolchain (e.g. `astro build`) or
// not at all.
export function discoverBuildableWorkspacePackages(rootDir: string): string[] {
  return discoverWorkspacePackages(rootDir).filter((dir) => {
    const pkg = JSON.parse(readFileSync(join(rootDir, dir, 'package.json'), 'utf8')) as {
      private?: boolean;
    };
    return pkg.private !== true;
  });
}
