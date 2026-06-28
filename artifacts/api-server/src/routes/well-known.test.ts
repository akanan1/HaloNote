import { generateKeyPairSync } from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import wellKnownRouter, {
  _resetJwksPublishCacheForTests,
} from "./well-known";

const ENV_KEYS = [
  "EPIC_PRIVATE_KEY",
  "EPIC_KEY_ID",
  "EPIC_ALGORITHM",
  "EPIC_PRIVATE_KEY_SANDBOX",
  "EPIC_KEY_ID_SANDBOX",
  "EPIC_ALGORITHM_SANDBOX",
] as const;

function snapshotEnv(): Partial<Record<(typeof ENV_KEYS)[number], string>> {
  const snap: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
  for (const k of ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) snap[k] = v;
  }
  return snap;
}

function restoreEnv(
  snap: Partial<Record<(typeof ENV_KEYS)[number], string>>,
): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function newP384Pem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-384" });
  return String(privateKey.export({ type: "pkcs8", format: "pem" }));
}

function buildApp(): Express {
  const app = express();
  app.use("/.well-known", wellKnownRouter);
  return app;
}

describe("GET /.well-known/jwks.json", () => {
  const original = snapshotEnv();

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    _resetJwksPublishCacheForTests();
  });

  afterEach(() => {
    restoreEnv(original);
    _resetJwksPublishCacheForTests();
  });

  it("returns an empty keys array when EPIC_PRIVATE_KEY is unset", async () => {
    const app = buildApp();
    const res = await request(app).get("/.well-known/jwks.json");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ keys: [] });
    expect(res.headers["cache-control"]).toContain("max-age=3600");
  });

  it("returns the Epic public JWK when EPIC_PRIVATE_KEY + EPIC_KEY_ID are set", async () => {
    process.env["EPIC_PRIVATE_KEY"] = newP384Pem();
    process.env["EPIC_KEY_ID"] = "test-kid-001";
    // Default algorithm should be ES384.

    const app = buildApp();
    const res = await request(app).get("/.well-known/jwks.json");
    expect(res.status).toBe(200);
    expect(res.body.keys).toHaveLength(1);
    const [jwk] = res.body.keys;
    expect(jwk.kid).toBe("test-kid-001");
    expect(jwk.use).toBe("sig");
    expect(jwk.alg).toBe("ES384");
    expect(jwk.kty).toBe("EC");
    expect(jwk.crv).toBe("P-384");
    // Private-key material must NEVER appear in the published JWK.
    expect(jwk.d).toBeUndefined();
  });

  it("accepts a PEM with literal \\n escapes (env-var-friendly format)", async () => {
    const real = newP384Pem();
    process.env["EPIC_PRIVATE_KEY"] = real.replace(/\n/g, "\\n");
    process.env["EPIC_KEY_ID"] = "escaped-kid";

    const app = buildApp();
    const res = await request(app).get("/.well-known/jwks.json");
    expect(res.status).toBe(200);
    expect(res.body.keys).toHaveLength(1);
    expect(res.body.keys[0].kid).toBe("escaped-kid");
  });

  it("re-derives the JWK when EPIC_KEY_ID changes between calls (cache busts)", async () => {
    process.env["EPIC_PRIVATE_KEY"] = newP384Pem();
    process.env["EPIC_KEY_ID"] = "kid-1";
    const app = buildApp();

    const first = await request(app).get("/.well-known/jwks.json");
    expect(first.body.keys[0].kid).toBe("kid-1");

    process.env["EPIC_KEY_ID"] = "kid-2";
    const second = await request(app).get("/.well-known/jwks.json");
    expect(second.body.keys[0].kid).toBe("kid-2");
  });

  it("returns an empty set when EPIC_PRIVATE_KEY is set but EPIC_KEY_ID is missing", async () => {
    // Without a kid, Epic can't identify which key signed an assertion,
    // so publishing the JWK would be pointless. Fail safe to empty.
    process.env["EPIC_PRIVATE_KEY"] = newP384Pem();

    const app = buildApp();
    const res = await request(app).get("/.well-known/jwks.json");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ keys: [] });
  });
});

describe("GET /.well-known/jwks-sandbox.json", () => {
  const original = snapshotEnv();

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    _resetJwksPublishCacheForTests();
  });

  afterEach(() => {
    restoreEnv(original);
    _resetJwksPublishCacheForTests();
  });

  it("returns the sandbox JWK from EPIC_PRIVATE_KEY_SANDBOX, NOT from EPIC_PRIVATE_KEY", async () => {
    // The whole point of separate sandbox/prod endpoints is that a
    // sandbox key compromise must not expose prod. Confirm the sandbox
    // route ignores the production env vars entirely.
    process.env["EPIC_PRIVATE_KEY"] = newP384Pem();
    process.env["EPIC_KEY_ID"] = "prod-kid";
    process.env["EPIC_PRIVATE_KEY_SANDBOX"] = newP384Pem();
    process.env["EPIC_KEY_ID_SANDBOX"] = "sandbox-kid";

    const app = buildApp();
    const res = await request(app).get("/.well-known/jwks-sandbox.json");
    expect(res.status).toBe(200);
    expect(res.body.keys).toHaveLength(1);
    expect(res.body.keys[0].kid).toBe("sandbox-kid");
  });

  it("is empty when only the production keypair is configured", async () => {
    // Confirms the converse: production env vars never bleed into the
    // sandbox endpoint.
    process.env["EPIC_PRIVATE_KEY"] = newP384Pem();
    process.env["EPIC_KEY_ID"] = "prod-only";

    const app = buildApp();
    const res = await request(app).get("/.well-known/jwks-sandbox.json");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ keys: [] });
  });

  it("returns an empty set when neither env family is configured", async () => {
    const app = buildApp();
    const res = await request(app).get("/.well-known/jwks-sandbox.json");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ keys: [] });
  });
});

describe("sandbox/production isolation", () => {
  const original = snapshotEnv();

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    _resetJwksPublishCacheForTests();
  });

  afterEach(() => {
    restoreEnv(original);
    _resetJwksPublishCacheForTests();
  });

  it("serves different kids on /jwks.json vs /jwks-sandbox.json when both are configured", async () => {
    process.env["EPIC_PRIVATE_KEY"] = newP384Pem();
    process.env["EPIC_KEY_ID"] = "prod-kid";
    process.env["EPIC_PRIVATE_KEY_SANDBOX"] = newP384Pem();
    process.env["EPIC_KEY_ID_SANDBOX"] = "sandbox-kid";

    const app = buildApp();
    const prod = await request(app).get("/.well-known/jwks.json");
    const sandbox = await request(app).get("/.well-known/jwks-sandbox.json");
    expect(prod.body.keys[0].kid).toBe("prod-kid");
    expect(sandbox.body.keys[0].kid).toBe("sandbox-kid");
    // Cross-check: kids must not match. Epic requires distinct URLs
    // BECAUSE the keys must be distinct.
    expect(prod.body.keys[0].kid).not.toBe(sandbox.body.keys[0].kid);
  });
});
