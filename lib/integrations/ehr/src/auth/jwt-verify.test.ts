import { generateKeyPairSync, createPublicKey, type KeyObject } from "node:crypto";
import { describe, expect, it, beforeAll } from "vitest";
import { signJwt } from "./jwt";
import { JwksClient } from "./jwks";
import { verifyJwt, JwtVerificationError } from "./jwt";

interface KeyPair {
  privatePem: string;
  publicJwk: Record<string, unknown>;
  kid: string;
}

function makeRsaKey(kid: string): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const privatePem = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  // export JWK with kid attached for the JWKS doc
  const jwkBase = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return { privatePem, publicJwk: { ...jwkBase, kid, alg: "RS256" }, kid };
}

function fetchImplFor(jwks: { keys: Record<string, unknown>[] }): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(jwks), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("verifyJwt", () => {
  let kp: KeyPair;
  let jwks: JwksClient;

  beforeAll(() => {
    kp = makeRsaKey("test-kid-1");
    jwks = new JwksClient({
      jwksUri: "https://example.test/keys",
      fetchImpl: fetchImplFor({ keys: [kp.publicJwk] }),
    });
  });

  async function sign(
    claims: Record<string, unknown>,
    header: Record<string, unknown> = {},
  ): Promise<string> {
    return signJwt({
      header: { kid: kp.kid, ...header },
      claims,
      algorithm: "RS256",
      privateKey: kp.privatePem,
    });
  }

  it("accepts a well-formed signed JWT with matching aud", async () => {
    const token = await sign({
      iss: "https://idp.test",
      aud: "client-1",
      exp: Math.floor(Date.now() / 1000) + 300,
      fhirUser: "Practitioner/abc-123",
    });
    const { claims } = await verifyJwt({
      token,
      jwks,
      expectedAudience: "client-1",
      expectedIssuer: "https://idp.test",
    });
    expect(claims["fhirUser"]).toBe("Practitioner/abc-123");
  });

  it("rejects a tampered payload", async () => {
    const token = await sign({
      aud: "client-1",
      exp: Math.floor(Date.now() / 1000) + 300,
      fhirUser: "Practitioner/legit",
    });
    const parts = token.split(".");
    const evilClaims = Buffer.from(
      JSON.stringify({
        aud: "client-1",
        exp: Math.floor(Date.now() / 1000) + 300,
        fhirUser: "Practitioner/EVIL",
      }),
    )
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const tampered = `${parts[0]}.${evilClaims}.${parts[2]}`;
    await expect(
      verifyJwt({ token: tampered, jwks, expectedAudience: "client-1" }),
    ).rejects.toMatchObject({ reason: "bad_signature" });
  });

  it("rejects alg=none even with empty signature", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }))
      .toString("base64url");
    const claims = Buffer.from(
      JSON.stringify({ aud: "client-1", exp: Math.floor(Date.now() / 1000) + 300 }),
    ).toString("base64url");
    const token = `${header}.${claims}.`;
    await expect(
      verifyJwt({ token, jwks, expectedAudience: "client-1" }),
    ).rejects.toBeInstanceOf(JwtVerificationError);
  });

  it("rejects HS256 substitution (alg confusion)", async () => {
    // Even if an attacker swaps alg to HS256, our verifier rejects on
    // the allowed-algs gate before any key material gets near an HMAC.
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", kid: kp.kid, typ: "JWT" }),
    ).toString("base64url");
    const claims = Buffer.from(
      JSON.stringify({ aud: "client-1", exp: Math.floor(Date.now() / 1000) + 300 }),
    ).toString("base64url");
    const token = `${header}.${claims}.AAAA`;
    await expect(
      verifyJwt({ token, jwks, expectedAudience: "client-1" }),
    ).rejects.toMatchObject({ reason: "alg_not_allowed:HS256" });
  });

  it("rejects an expired token", async () => {
    const token = await sign({
      aud: "client-1",
      exp: Math.floor(Date.now() / 1000) - 3600,
    });
    await expect(
      verifyJwt({
        token,
        jwks,
        expectedAudience: "client-1",
        clockToleranceSec: 0,
      }),
    ).rejects.toMatchObject({ reason: "expired" });
  });

  it("rejects an audience mismatch", async () => {
    const token = await sign({
      aud: "client-1",
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    await expect(
      verifyJwt({ token, jwks, expectedAudience: "different-client" }),
    ).rejects.toMatchObject({ reason: "audience_mismatch" });
  });

  it("rejects malformed tokens", async () => {
    await expect(
      verifyJwt({ token: "not.a.jwt.extra", jwks, expectedAudience: "client-1" }),
    ).rejects.toMatchObject({ reason: "malformed_token" });
    await expect(
      verifyJwt({ token: "abc.def", jwks, expectedAudience: "client-1" }),
    ).rejects.toMatchObject({ reason: "malformed_token" });
  });
});

describe("JwksClient", () => {
  it("force-refreshes on unknown kid, then succeeds", async () => {
    const kp1 = makeRsaKey("kid-1");
    const kp2 = makeRsaKey("kid-2");
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      const body =
        call === 1
          ? { keys: [kp1.publicJwk] }
          : { keys: [kp1.publicJwk, kp2.publicJwk] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = new JwksClient({
      jwksUri: "https://example.test/keys",
      fetchImpl,
      refreshCooldownMs: 0,
    });
    // First call: populates with kid-1.
    const k1 = await client.getKey("kid-1");
    expect(k1).toBeDefined();
    // Asking for kid-2 should trigger a force refresh and then succeed.
    const k2 = await client.getKey("kid-2");
    expect(k2).toBeDefined();
    expect(call).toBe(2);
  });

  it("throws JwksKeyNotFoundError after force-refresh still misses", async () => {
    const kp1 = makeRsaKey("only-kid");
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ keys: [kp1.publicJwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const client = new JwksClient({
      jwksUri: "https://example.test/keys",
      fetchImpl,
      refreshCooldownMs: 0,
    });
    await expect(client.getKey("missing-kid")).rejects.toMatchObject({
      name: "JwksKeyNotFoundError",
    });
  });

  it("rate-limits force refresh via cooldown", async () => {
    const kp1 = makeRsaKey("only-kid");
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return new Response(JSON.stringify({ keys: [kp1.publicJwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = new JwksClient({
      jwksUri: "https://example.test/keys",
      fetchImpl,
      refreshCooldownMs: 60_000,
    });
    await client.getKey("only-kid"); // initial fetch
    expect(call).toBe(1);
    await expect(client.getKey("missing-1")).rejects.toBeDefined(); // force refresh #1
    expect(call).toBe(2);
    await expect(client.getKey("missing-2")).rejects.toBeDefined(); // cooldown blocks
    expect(call).toBe(2);
  });
});

// Silence unused-import lint on createPublicKey/KeyObject (re-export aids tooling).
void createPublicKey;
void (null as unknown as KeyObject);
