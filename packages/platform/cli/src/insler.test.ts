import { describe, expect, test } from 'bun:test';

import { main } from './insler.js';

const FIXTURES = new URL('../../platform/src/fleet/__fixtures__/', import.meta.url).pathname;

// --- AC7: the `insler` binary dispatches `scan` ---

describe('main — command dispatch (AC7)', () => {
  test('`scan <dir>` runs the scan and returns its exit code', async () => {
    const code = await main(['scan', `${FIXTURES}valid`]);
    expect(code).toBe(0);
  });

  test('`scan <invalid-dir>` returns a non-zero exit code', async () => {
    const code = await main(['scan', `${FIXTURES}dup-name`]);
    expect(code).toBe(1);
  });

  test('an unknown command exits non-zero', async () => {
    const code = await main(['frobnicate']);
    expect(code).toBe(1);
  });

  test('--help exits zero', async () => {
    const code = await main(['--help']);
    expect(code).toBe(0);
  });

  test('`generate <dir> --dry-run` runs the generator and returns its exit code', async () => {
    const code = await main(['generate', `${FIXTURES}valid`, '--dry-run']);
    expect(code).toBe(0);
  });

  test('`generate <invalid-dir>` returns a non-zero exit code', async () => {
    const code = await main(['generate', `${FIXTURES}dup-name`, '--dry-run']);
    expect(code).toBe(1);
  });

  test('a value-taking flag never swallows the following flag as its value', async () => {
    // A dangling `--env` before `--dry-run`: `--dry-run` must still be honored
    // (nothing written), not consumed as the environment name.
    const code = await main(['generate', `${FIXTURES}valid`, '--env', '--dry-run']);
    expect(code).toBe(0);
  });

  test('a dangling value-taking flag at end of argv is ignored', async () => {
    const code = await main(['plan', `${FIXTURES}valid`, '--state']);
    expect(code).toBe(0);
  });

  test('`plan <dir>` runs the reconciler plan and returns its exit code', async () => {
    const code = await main(['plan', `${FIXTURES}valid`]);
    expect(code).toBe(0);
  });

  test('`plan <invalid-dir>` returns a non-zero exit code', async () => {
    const code = await main(['plan', `${FIXTURES}dup-name`]);
    expect(code).toBe(1);
  });

  test('`apply <dir> --dry-run` runs the reconciler apply and returns its exit code', async () => {
    const code = await main(['apply', `${FIXTURES}valid`, '--dry-run']);
    expect(code).toBe(0);
  });

  test('`apply <invalid-dir> --dry-run` returns a non-zero exit code', async () => {
    const code = await main(['apply', `${FIXTURES}dup-name`, '--dry-run']);
    expect(code).toBe(1);
  });

  // --- 0022 AC6/AC7: `insler dev` exists and refuses production ---

  test('`dev <dir> --env production` is refused with a non-zero exit code (AC6)', async () => {
    const code = await main(['dev', `${FIXTURES}valid`, '--env', 'production']);
    expect(code).toBe(1);
  });
});
