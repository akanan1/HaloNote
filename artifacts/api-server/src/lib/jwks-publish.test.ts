import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildJwksDocument, publicJwkFromPem } from "./jwks-publish";

function newEcKeypairPem(curve: "P-256" | "P-384" | "P-521"): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: curve });
  return String(privateKey.export({ type: "pkcs8", format: "pem" }));
}

function newRsaKeypairPem(modulusLength: number): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength });
  return String(privateKey.export({ type: "pkcs8", format: "pem" }));
}

describe("publicJwkFromPem", () => {
  it("derives a sig-use ES384 public JWK from a P-384 PEM with kid + alg", () => {
    const pem = newEcKeypairPem("P-384");
    const jwk = publicJwkFromPem({
      privateKeyPem: pem,
      kid: "kid-abc",
      algorithm: "ES384",
    });
    expect(jwk.kty).toBe("EC");
    expect(jwk.kid).toBe("kid-abc");
    expect(jwk.use).toBe("sig");
    expect(jwk.alg).toBe("ES384");
    if (jwk.kty !== "EC") throw new Error("type narrow");
    expect(jwk.crv).toBe("P-384");
    expect(jwk.x).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(jwk.y).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("derives an RSA public JWK from an RSA PEM (n + e)", () => {
    const pem = newRsaKeypairPem(2048);
    const jwk = publicJwkFromPem({
      privateKeyPem: pem,
      kid: "rsa-kid",
      algorithm: "RS384",
    });
    expect(jwk.kty).toBe("RSA");
    if (jwk.kty !== "RSA") throw new Error("type narrow");
    expect(jwk.n).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(jwk.e).toBe("AQAB");
    expect(jwk.alg).toBe("RS384");
  });

  it("never leaks private-key material (d) into the published JWK", () => {
    // Critical security property: the published JWK is what gets served
    // at /.well-known/jwks.json; a leaked `d` field would expose the
    // signing key.
    const pem = newEcKeypairPem("P-384");
    const jwk = publicJwkFromPem({
      privateKeyPem: pem,
      kid: "k",
      algorithm: "ES384",
    });
    expect((jwk as unknown as { d?: string }).d).toBeUndefined();
  });

  it("throws on an unparseable PEM", () => {
    expect(() =>
      publicJwkFromPem({
        privateKeyPem: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----",
        kid: "k",
        algorithm: "ES384",
      }),
    ).toThrow();
  });
});

describe("buildJwksDocument", () => {
  it("emits an empty keys array when no sources provided", () => {
    expect(buildJwksDocument([])).toEqual({ keys: [] });
  });

  it("preserves source order so the primary kid is first", () => {
    const pem1 = newEcKeypairPem("P-384");
    const pem2 = newEcKeypairPem("P-384");
    const doc = buildJwksDocument([
      { privateKeyPem: pem1, kid: "primary", algorithm: "ES384" },
      { privateKeyPem: pem2, kid: "secondary", algorithm: "ES384" },
    ]);
    expect(doc.keys.map((k) => k.kid)).toEqual(["primary", "secondary"]);
  });
});
