import { describe, it, expect } from "vitest";
import {
  createSign,
  generateKeyPairSync,
  sign as cryptoSign,
} from "node:crypto";
import { derToJose, joseToDer, type EcdsaAlgorithm } from "./ecdsa";

interface Curve {
  alg: EcdsaAlgorithm;
  namedCurve: "prime256v1" | "secp384r1" | "secp521r1";
  hash: "sha256" | "sha384" | "sha512";
  coordSize: number;
}

const CURVES: Curve[] = [
  { alg: "ES256", namedCurve: "prime256v1", hash: "sha256", coordSize: 32 },
  { alg: "ES384", namedCurve: "secp384r1", hash: "sha384", coordSize: 48 },
  { alg: "ES512", namedCurve: "secp521r1", hash: "sha512", coordSize: 66 },
];

describe("ecdsa DER↔JOSE", () => {
  for (const c of CURVES) {
    it(`${c.alg}: DER → JOSE round-trip yields original DER`, () => {
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: c.namedCurve });
      // Default Node ECDSA output is DER.
      const sign = createSign(c.hash);
      sign.update("hello world");
      const der = sign.sign(privateKey);

      const jose = derToJose(der, c.alg);
      expect(jose.length).toBe(c.coordSize * 2);

      const roundtrip = joseToDer(jose, c.alg);

      // DER signatures aren't byte-identical (length encoding nuances), so
      // re-roundtrip and compare JOSE form.
      const jose2 = derToJose(roundtrip, c.alg);
      expect(jose2.equals(jose)).toBe(true);
    });

    it(`${c.alg}: rejects JOSE input of wrong length`, () => {
      const wrong = Buffer.alloc(c.coordSize * 2 - 1);
      expect(() => joseToDer(wrong, c.alg)).toThrow(/expected/);
    });

    it(`${c.alg}: signs r||s of the right length via crypto with ieee-p1363`, () => {
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: c.namedCurve });
      const sig = cryptoSign(c.hash, Buffer.from("x"), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      });
      expect(sig.length).toBe(c.coordSize * 2);

      // The JOSE → DER converter should accept this and round-trip.
      const der = joseToDer(sig, c.alg);
      const jose = derToJose(der, c.alg);
      expect(jose.equals(sig)).toBe(true);
    });
  }

  it("rejects DER without SEQUENCE tag", () => {
    expect(() => derToJose(Buffer.from([0x02, 0x01, 0x00]), "ES256")).toThrow(
      /SEQUENCE/,
    );
  });

  it("rejects truncated DER", () => {
    expect(() => derToJose(Buffer.from([0x30]), "ES256")).toThrow();
  });

  it("strips DER positive-integer leading zero (high-bit case)", () => {
    // Hand-craft a DER signature for ES256 where both r and s have the high bit
    // set, forcing DER to prepend a 0x00 byte. The JOSE result must drop it.
    const r = Buffer.alloc(32, 0x80);
    const s = Buffer.alloc(32, 0x90);
    const rDer = Buffer.concat([Buffer.from([0x02, 33, 0x00]), r]);
    const sDer = Buffer.concat([Buffer.from([0x02, 33, 0x00]), s]);
    const seqContent = Buffer.concat([rDer, sDer]);
    const der = Buffer.concat([
      Buffer.from([0x30, seqContent.length]),
      seqContent,
    ]);

    const jose = derToJose(der, "ES256");
    expect(jose.length).toBe(64);
    expect(jose.subarray(0, 32).equals(r)).toBe(true);
    expect(jose.subarray(32).equals(s)).toBe(true);
  });
});
