export interface Serde<Wire = unknown> {
  encode(value: unknown): Wire;
  decode(wire: Wire): unknown;
}
