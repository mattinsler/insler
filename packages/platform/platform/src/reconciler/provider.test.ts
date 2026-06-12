import { describe, expect, test } from 'bun:test';

import { createMemoryStateProvider } from './provider.js';
import type { Resource } from './types.js';

function r(path: string, content: string): Resource {
  return { path, content, format: 'yaml' };
}

// The in-memory provider is the testable fake the engine reconciles against
// while real backends do not yet exist.

describe('createMemoryStateProvider', () => {
  test('starts empty by default', async () => {
    const provider = createMemoryStateProvider();
    expect(await provider.getActual()).toEqual([]);
    expect(await provider.getLastApplied()).toEqual([]);
  });

  test('seeds initial actual state', async () => {
    const provider = createMemoryStateProvider([r('a', '1')]);
    expect(await provider.getActual()).toEqual([r('a', '1')]);
  });

  test('setApplied records both the new actual and the new last-applied', async () => {
    const provider = createMemoryStateProvider();
    await provider.setApplied([r('a', '1')]);
    expect(await provider.getActual()).toEqual([r('a', '1')]);
    expect(await provider.getLastApplied()).toEqual([r('a', '1')]);
  });

  test('setApplied with preserveLastApplied updates actual only (drift correction)', async () => {
    const provider = createMemoryStateProvider([r('a', 'drifted')], [r('a', 'applied')]);
    await provider.setApplied([r('a', 'applied'), r('extra', 'live')], {
      preserveLastApplied: true,
    });
    expect(await provider.getActual()).toEqual([r('a', 'applied'), r('extra', 'live')]);
    expect(await provider.getLastApplied()).toEqual([r('a', 'applied')]);
  });

  test('can seed actual and last-applied independently to model pre-existing drift', async () => {
    const provider = createMemoryStateProvider([r('a', 'drifted')], [r('a', 'applied')]);
    expect(await provider.getActual()).toEqual([r('a', 'drifted')]);
    expect(await provider.getLastApplied()).toEqual([r('a', 'applied')]);
  });

  test('returns copies so callers cannot mutate provider state', async () => {
    const provider = createMemoryStateProvider([r('a', '1')]);
    const actual = (await provider.getActual()) as Resource[];
    actual.push(r('b', '2'));
    expect(await provider.getActual()).toEqual([r('a', '1')]);
  });
});
