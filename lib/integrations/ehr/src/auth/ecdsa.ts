import type { JwtSigningAlgorithm } from "./types";

export type EcdsaAlgorithm = Extract<
  JwtSigningAlgorithm,
  "ES256" | "ES384" | "ES512"
>;

// Coordinate size in bytes per curve. ES512 uses P-521 (not P-512), so its
// coordinate is ceil(521 / 8) = 66 bytes — easy to get wrong.
const COORD_SIZE: Record<EcdsaAlgorithm, number> = {
  ES256: 32,
  ES384: 48,
  ES512: 66,
};

/**
 * Convert an ASN.1 DER-encoded ECDSA signature to JOSE / IEEE-P1363
 * format (`r || s`, each zero-padded to the curve's coordinate size).
 *
 * KMS / HSM / cloud key vaults almost universally return DER for ECDSA;
 * JWS rejects DER and requires the raw concatenated form. Use this
 * inside a `JwtSigner` callback when wiring up an ECDSA KMS key:
 *
 * ```ts
 * signer: async (signingInput, algorithm) => {
 *   const out = await kms.send(new SignCommand({ ... }));
 *   return derToJose(out.Signature!, algorithm as EcdsaAlgorithm);
 * }
 * ```
 *
 * Throws if the input is not well-formed DER or if `r`/`s` exceeds the
 * curve's coordinate size.
 */
export function derToJose(
  der: Buffer | Uint8Array,
  algorithm: EcdsaAlgorithm,
): Buffer {
  const buf = Buffer.isBuffer(der) ? der : Buffer.from(der);
  const coordSize = COORD_SIZE[algorithm];

  let offset = 0;
  if (buf[offset++] !== 0x30) {
    throw new Error("Invalid DER signature: expected SEQUENCE (0x30).");
  }

  const seqLen = readLength(buf, offset);
  offset = seqLen.next;
  if (offset + seqLen.value !== buf.length) {
    throw new Error(
      "Invalid DER signature: declared SEQUENCE length does not match buffer length.",
    );
  }

  const r = readInteger(buf, offset);
  offset = r.next;
  const s = readInteger(buf, offset);
  offset = s.next;

  if (offset !== buf.length) {
    throw new Error(
      "Invalid DER signature: trailing bytes after second INTEGER.",
    );
  }

  return Buffer.concat([
    padToCoord(r.value, coordSize),
    padToCoord(s.value, coordSize),
  ]);
}

function readByte(buf: Buffer, offset: number): number {
  const b = buf[offset];
  if (b === undefined) {
    throw new Error("Invalid DER signature: unexpected end of buffer.");
  }
  return b;
}

function readLength(
  buf: Buffer,
  offset: number,
): { value: number; next: number } {
  const first = readByte(buf, offset++);
  if ((first & 0x80) === 0) {
    return { value: first, next: offset };
  }
  const lenBytes = first & 0x7f;
  if (lenBytes === 0 || lenBytes > 2) {
    throw new Error(
      `Invalid DER signature: unsupported length form (${lenBytes} bytes).`,
    );
  }
  let value = 0;
  for (let i = 0; i < lenBytes; i++) {
    value = (value << 8) | readByte(buf, offset++);
  }
  return { value, next: offset };
}

function readInteger(
  buf: Buffer,
  offset: number,
): { value: Buffer; next: number } {
  if (readByte(buf, offset++) !== 0x02) {
    throw new Error("Invalid DER signature: expected INTEGER (0x02).");
  }
  const len = readLength(buf, offset);
  offset = len.next;
  let value = buf.subarray(offset, offset + len.value);
  offset += len.value;
  // Strip DER's positive-integer leading-zero byte (added when the high
  // bit of the magnitude would otherwise mark the integer as negative).
  while (value.length > 1 && value[0] === 0x00) {
    value = value.subarray(1);
  }
  return { value, next: offset };
}

function padToCoord(value: Buffer, size: number): Buffer {
  if (value.length > size) {
    throw new Error(
      `Invalid ECDSA component: ${value.length} bytes exceeds coordinate size ${size}.`,
    );
  }
  if (value.length === size) return value;
  const padded = Buffer.alloc(size);
  value.copy(padded, size - value.length);
  return padded;
}

/**
 * Convert a JOSE / IEEE-P1363 ECDSA signature (`r || s`, each padded to
 * the curve's coordinate size) back to ASN.1 DER. Useful when verifying
 * a JOSE-encoded signature with a tool that expects DER (e.g. Node's
 * `crypto.verify` without `dsaEncoding: "ieee-p1363"`, or OpenSSL).
 *
 * Throws if the input length doesn't match `2 * coordSize` for the
 * given algorithm.
 */
export function joseToDer(
  jose: Buffer | Uint8Array,
  algorithm: EcdsaAlgorithm,
): Buffer {
  const buf = Buffer.isBuffer(jose) ? jose : Buffer.from(jose);
  const coordSize = COORD_SIZE[algorithm];

  if (buf.length !== coordSize * 2) {
    throw new Error(
      `Invalid JOSE signature: expected ${coordSize * 2} bytes for ${algorithm}, got ${buf.length}.`,
    );
  }

  const rTlv = encodeInteger(buf.subarray(0, coordSize));
  const sTlv = encodeInteger(buf.subarray(coordSize));
  const seqContent = Buffer.concat([rTlv, sTlv]);

  return Buffer.concat([
    Buffer.from([0x30]),
    encodeLength(seqContent.length),
    seqContent,
  ]);
}

function encodeInteger(magnitude: Buffer): Buffer {
  // DER requires minimum encoding — strip leading zeros, but keep at
  // least one byte so a literal 0 still encodes as `02 01 00`.
  let start = 0;
  while (start < magnitude.length - 1 && magnitude[start] === 0x00) {
    start++;
  }
  let bytes = magnitude.subarray(start);
  // If the high bit is set, prepend 0x00 so DER reads the integer as
  // positive instead of two's-complement negative.
  const head = bytes[0];
  if (head !== undefined && (head & 0x80) !== 0) {
    bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
  }
  return Buffer.concat([
    Buffer.from([0x02]),
    encodeLength(bytes.length),
    bytes,
  ]);
}

function encodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x100) return Buffer.from([0x81, len]);
  if (len < 0x10000) {
    return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
  }
  throw new Error(`Length too large for DER encoding: ${len}.`);
}
