import type { Serde } from '@insler/serde';
import { decode, encode } from '@msgpack/msgpack';

export const msgpackSerde: Serde<Uint8Array> = {
  encode(value: unknown): Uint8Array {
    if (value === undefined) {
      return new Uint8Array(0);
    }
    return encode(value);
  },
  decode(wire: Uint8Array): unknown {
    if (wire.length === 0) {
      return undefined;
    }
    return decode(wire);
  },
};
