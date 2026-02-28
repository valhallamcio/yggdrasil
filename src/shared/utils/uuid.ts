import { Binary } from 'mongodb';

/**
 * Converts a MongoDB Binary subtype 3 UUID to a standard UUID string.
 * The binary format stores MSB (bytes 0-7) and LSB (bytes 8-15) each reversed.
 */
export function binaryToUuid(bin: Binary): string {
  const raw = bin.buffer;
  const msb = Buffer.from(raw.subarray(0, 8)).reverse();
  const lsb = Buffer.from(raw.subarray(8, 16)).reverse();
  const hex = Buffer.concat([msb, lsb]).toString('hex');
  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}`;
}

/**
 * Converts a standard UUID string to MongoDB Binary subtype 3.
 * Reverses each 8-byte half to match the stored binary format.
 */
export function uuidToBinary(uuid: string): Binary {
  const hex = uuid.replace(/-/g, '');
  const buf = Buffer.from(hex, 'hex');
  const msb = Buffer.from(buf.subarray(0, 8)).reverse();
  const lsb = Buffer.from(buf.subarray(8, 16)).reverse();
  return new Binary(Buffer.concat([msb, lsb]), 3);
}
