export interface Propagator {
  inject(context: Record<string, unknown>, carrier: Record<string, string>): void;
  extract(keys: readonly string[], carrier: Record<string, string>): Record<string, unknown>;
}
