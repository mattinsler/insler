#!/usr/bin/env bun
/**
 * Build one or more workspace packages by name.
 *
 * Usage:
 *   bun run scripts/build.ts <package> [<package> ...]
 *
 * Each <package> may be the full workspace name (e.g. "@insler/client")
 * or its short form (e.g. "client").
 */
import * as path from 'node:path';

import { Glob } from 'bun';

const ROOT = path.resolve(import.meta.dir, '..');

interface Pkg {
  name: string;
  dir: string;
  hasBuild: boolean;
}

async function loadWorkspacePackages(): Promise<Pkg[]> {
  const glob = new Glob('packages/*/package.json');
  const packages: Pkg[] = [];

  for await (const rel of glob.scan(ROOT)) {
    const pkgPath = path.join(ROOT, rel);
    const json = await Bun.file(pkgPath).json();
    if (!json.name) continue;
    packages.push({
      name: json.name,
      dir: path.dirname(pkgPath),
      hasBuild: Boolean(json.scripts?.build),
    });
  }

  return packages;
}

function resolvePackage(arg: string, packages: Pkg[]): Pkg | undefined {
  return packages.find((pkg) => pkg.name === arg || pkg.name.replace(/^@[^/]+\//, '') === arg);
}

async function getPackages(args: string[]) {
  const packages = await loadWorkspacePackages();
  if (args.length === 0) {
    return packages;
  }

  const targets: Pkg[] = [];
  const unknown: string[] = [];

  for (const arg of args) {
    const pkg = resolvePackage(arg, packages);
    if (pkg) {
      targets.push(pkg);
    } else {
      unknown.push(arg);
    }
  }

  if (unknown.length > 0) {
    console.error(`Unknown workspace package(s): ${unknown.join(', ')}`);
    console.error(`Available packages:\n${packages.map((p) => `  - ${p.name}`).join('\n')}`);
    process.exit(1);
  }

  return targets;
}

async function main() {
  const targets = await getPackages(Bun.argv.slice(2));

  if (targets.length === 0) {
    console.error('No packages to build');
    process.exit(1);
  }

  const proc = Bun.spawn(
    [
      'bun',
      'run',
      '--parallel',
      '--no-exit-on-error',
      '--if-present',
      ...targets.flatMap((pkg) => ['-F', pkg.name]),
      'build',
    ],
    {
      stdout: 'inherit',
      stderr: 'inherit',
    }
  );
  process.exitCode = await proc.exited;
}

main().finally(() => {
  process.exit();
});
