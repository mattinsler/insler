import type { Serde } from '@insler/serde';
import superjson from 'superjson';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const jsonSerde: Serde<string> = {
  encode(value: unknown): string {
    if (value === undefined) {
      return '';
    }
    return superjson.stringify(value);
  },
  decode(wire: string): unknown {
    if (wire === '') {
      return undefined;
    }
    return superjson.parse(wire);
  },
};

export const jsonBytesSerde: Serde<Uint8Array> = {
  encode(value: unknown): Uint8Array {
    return textEncoder.encode(jsonSerde.encode(value));
  },
  decode(wire: Uint8Array): unknown {
    return jsonSerde.decode(textDecoder.decode(wire));
  },
};
