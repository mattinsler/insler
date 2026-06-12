export class Managed<T> {
  declare readonly __type: T;
  readonly value: T;
  readonly stop?: () => Promise<void>;

  constructor(value: T, stop?: () => Promise<void>) {
    this.value = value;
    this.stop = stop;
  }
}

export function managed<T>(value: T, stop?: () => Promise<void>): Managed<T> {
  return new Managed(value, stop);
}

export function isManaged(value: unknown): value is Managed<unknown> {
  return value instanceof Managed;
}
