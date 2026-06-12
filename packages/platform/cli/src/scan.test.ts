import { describe, expect, test } from 'bun:test';

import type { FleetResult } from '@insler/platform/fleet';
import { expectTypeOf } from 'expect-type';

import { runScan } from './scan.js';
import type { ScanArgs, ScanIO } from './scan.js';

const FIXTURES = new URL('../../platform/src/fleet/__fixtures__/', import.meta.url).pathname;

/** Capture out/err lines for assertion. */
function captureIO(): ScanIO & { readonly outLines: string[]; readonly errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    out: (line: string) => outLines.push(line),
    err: (line: string) => errLines.push(line),
  };
}

// --- AC7: `insler scan` over a real fleet ---

describe('runScan (AC7)', () => {
  test('scans a valid fleet, prints a summary, and exits 0', async () => {
    const io = captureIO();
    const code = await runScan({ cwd: `${FIXTURES}valid` }, io);

    expect(code).toBe(0);
    expect(io.errLines).toEqual([]);
    expect(io.outLines.join('\n')).toContain('Discovered 2 service(s)');
    expect(io.outLines.join('\n')).toContain('orders');
    expect(io.outLines.join('\n')).toContain('checkout');
  });

  test('--json emits the full manifest as JSON', async () => {
    const io = captureIO();
    const code = await runScan({ cwd: `${FIXTURES}valid`, json: true }, io);

    expect(code).toBe(0);
    const parsed = JSON.parse(io.outLines.join('\n')) as { services: unknown[] };
    expect(parsed.services.length).toBe(2);
  });

  test('reports fleet errors with file locations and exits 1', async () => {
    const io = captureIO();
    const code = await runScan({ cwd: `${FIXTURES}dup-name` }, io);

    expect(code).toBe(1);
    expect(io.outLines).toEqual([]);
    const errText = io.errLines.join('\n');
    expect(errText).toContain('duplicate-service-name');
    expect(errText).toContain('__fixtures__/dup-name/');
  });

  test('the scan dependency is injectable for isolated unit testing', async () => {
    const io = captureIO();
    const stub = async (): Promise<FleetResult> => ({
      manifest: { services: [], graph: { edges: [] }, expose: { routes: [] } },
      errors: [],
    });

    const code = await runScan({}, io, stub);
    expect(code).toBe(0);
    expect(io.outLines.join('\n')).toContain('Discovered 0 service(s)');
  });
});

describe('runScan types', () => {
  test('argument and return signatures', () => {
    expectTypeOf(runScan).parameter(0).toEqualTypeOf<ScanArgs>();
    expectTypeOf(runScan).parameter(1).toEqualTypeOf<ScanIO>();
    expectTypeOf(runScan).returns.resolves.toEqualTypeOf<number>();
  });
});
