import { describe, it, expect } from "vitest";
import {
  createVerify,
  generateKeyPairSync,
  verify as cryptoVerify,
} from "node:crypto";
import { signJwt } from "./jwt";
import { joseToDer } from "./ecdsa";

function decodeJwt(jwt: string): { header: unknown; claims: unknown } {
  const parts = jwt.split(".");
  expect(parts).toHaveLength(3);
  const [h, p] = parts as [string, string, string];
  const decode = (s: string): unknown =>
    JSON.parse(
      Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
        "utf8",
      ),
    );
  return { header: decode(h), claims: decode(p) };
}

describe("signJwt", () => {
  it("RS256: produces a header.payload.signature triplet with alg=RS256", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = await signJwt({
      header: { kid: "k1" },
      claims: { sub: "alice", iat: 1700000000 },
      algorithm: "RS256",
      privateKey,
    });
    const { header, claims } = decodeJwt(jwt);
    expect(header).toMatchObject({ alg: "RS256", typ: "JWT", kid: "k1" });
    expect(claims).toMatchObject({ sub: "alice", iat: 1700000000 });
  });

  it("RS256: signature verifies against the public key", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const jwt = await signJwt({
      header: {},
      claims: { x: 1 },
      algorithm: "RS256",
      privateKey,
    });
    const [h, p, s] = jwt.split(".") as [string, string, string];
    const signingInput = Buffer.from(`${h}.${p}`);
    const sig = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

    const verify = createVerify("sha256");
    verify.update(signingInput);
    expect(verify.verify(publicKey, sig)).toBe(true);
  });

  it("ES256: signature is r||s (64 bytes) and verifies", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const jwt = await signJwt({
      header: {},
      claims: { x: 1 },
      algorithm: "ES256",
      privateKey,
    });
    const [h, p, s] = jwt.split(".") as [string, string, string];
    const sig = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    expect(sig.length).toBe(64);

    // crypto.verify without dsaEncoding expects DER, so convert via joseToDer.
    const ok = cryptoVerify(
      "sha256",
      Buffer.from(`${h}.${p}`),
      publicKey,
      joseToDer(sig, "ES256"),
    );
    expect(ok).toBe(true);
  });

  it("rejects RSA key with ES256 algorithm", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await expect(
      signJwt({
        header: {},
        claims: {},
        algorithm: "ES256",
        privateKey,
      }),
    ).rejects.toThrow(/requires a ec key/);
  });

  it("rejects EC key with RS256 algorithm", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    await expect(
      signJwt({
        header: {},
        claims: {},
        algorithm: "RS256",
        privateKey,
      }),
    ).rejects.toThrow(/requires a rsa key/);
  });

  it("ES256 signer callback: rejects wrong-length output", async () => {
    await expect(
      signJwt({
        header: {},
        claims: {},
        algorithm: "ES256",
        signer: () => Buffer.alloc(70),
      }),
    ).rejects.toThrow(/expected 64 bytes/);
  });

  it("RS256 signer callback: passes the value through verbatim", async () => {
    const expected = Buffer.from("a".repeat(256));
    const jwt = await signJwt({
      header: {},
      claims: {},
      algorithm: "RS256",
      signer: () => expected,
    });
    const sigPart = jwt.split(".")[2]!;
    const decoded = Buffer.from(
      sigPart.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    );
    expect(decoded.equals(expected)).toBe(true);
  });
});
