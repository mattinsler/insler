import { Managed, isManaged } from './managed.js';

export function singleton<Args extends unknown[], T>(
  factory: (...args: Args) => T | Managed<T> | Promise<T | Managed<T>>
): (...args: Args) => Promise<Managed<T>> {
  let state: { value: T; refCount: number; stop?: () => Promise<void> } | undefined;
  let initializing: Promise<void> | undefined;

  return async (...args: Args) => {
    if (!state) {
      if (!initializing) {
        initializing = (async () => {
          try {
            const result = await factory(...args);
            if (isManaged(result)) {
              state = { value: result.value, refCount: 0, stop: result.stop };
            } else {
              state = { value: result as T, refCount: 0 };
            }
          } finally {
            initializing = undefined;
          }
        })();
      }
      await initializing;
    }

    state!.refCount++;
    return new Managed(state!.value, async () => {
      state!.refCount--;
      if (state!.refCount === 0) {
        const stop = state!.stop;
        state = undefined;
        await stop?.();
      }
    });
  };
}
