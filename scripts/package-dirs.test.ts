import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fixture test for `scripts/lib/package-dirs.sh` — the shared package
// discovery used by both publish pipelines (scripts/ci-publish.sh and
// mirror-scripts/publish-local.sh). It enumerates package directories at the
// nested subsystem depth (`packages/<subsystem>/<pkg>`) — any subsystem
// directory, including future ones — and lists nothing that is not a package
// (no package.json) and nothing at the retired flat depth.

const LIB = new URL('./lib/package-dirs.sh', import.meta.url).pathname;

let fixture: string;

beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'package-dirs-'));
  // flat package
  await mkdir(join(fixture, 'packages/flat-pkg/src'), { recursive: true });
  await writeFile(join(fixture, 'packages/flat-pkg/package.json'), '{"name":"flat-pkg"}');
  // nested package under a subsystem dir (the subsystem dir itself has no package.json)
  await mkdir(join(fixture, 'packages/sub/nested-pkg'), { recursive: true });
  await writeFile(join(fixture, 'packages/sub/nested-pkg/package.json'), '{"name":"nested-pkg"}');
  // junk at the nested depth: a flat package's src/ dir must not be listed
  await mkdir(join(fixture, 'packages/flat-pkg/coverage'), { recursive: true });
});

afterAll(async () => {
  await rm(fixture, { recursive: true, force: true });
});

async function discoveredDirs(cwd: string): Promise<string[]> {
  const proc = Bun.spawn(['bash', '-c', `source '${LIB}' && insler_package_dirs`], { cwd });
  const out = await proc.stdout.text();
  expect(await proc.exited).toBe(0);
  return out.split('\n').filter(Boolean).sort();
}

describe('insler_package_dirs', () => {
  test('enumerates nested packages from any subsystem dir, nothing else', async () => {
    expect(await discoveredDirs(fixture)).toEqual(['packages/sub/nested-pkg/']);
  });

  test('enumerates every existing package of this repo', async () => {
    const repoRoot = new URL('..', import.meta.url).pathname;
    const dirs = await discoveredDirs(repoRoot);
    expect(dirs).toContain('packages/di/di/');
    expect(dirs).toContain('packages/platform/platform/');
    expect(dirs).not.toContain('packages/');
    // no junk: only dirs that actually carry a package.json
    for (const dir of dirs) {
      expect(await Bun.file(join(repoRoot, dir, 'package.json')).exists()).toBe(true);
    }
  });

  test('is used by the CI publish pipeline', async () => {
    const ciPublish = await Bun.file(new URL('./ci-publish.sh', import.meta.url)).text();
    expect(ciPublish).toContain('lib/package-dirs.sh');
  });

  // mirror-scripts/ is stripped from public-mirror snapshots, so this
  // assertion only applies in the private repo.
  const publishLocalPath = new URL('../mirror-scripts/publish-local.sh', import.meta.url).pathname;
  test.if(existsSync(publishLocalPath))(
    'is used by the local-mirror publish pipeline',
    async () => {
      expect(await Bun.file(publishLocalPath).text()).toContain('lib/package-dirs.sh');
    }
  );
});
