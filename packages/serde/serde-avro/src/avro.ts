import type { Serde } from '@insler/serde';
import avro from 'avsc';

export type AvroSchema = avro.Schema;

export function createAvroSerde(schema: AvroSchema): Serde<Uint8Array> {
  const type = avro.Type.forSchema(schema);

  return {
    encode(value: unknown): Uint8Array {
      return Uint8Array.from(type.toBuffer(value));
    },
    decode(wire: Uint8Array): unknown {
      return type.fromBuffer(Buffer.from(wire));
    },
  };
}
