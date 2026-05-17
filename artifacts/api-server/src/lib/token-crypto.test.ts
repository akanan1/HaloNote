import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetKeyCacheForTests,
  decryptToken,
  encryptToken,
  looksLikeCiphertext,
  TokenDecryptError,
} from "./token-crypto";

const ENV_VAR = "EHR_TOKEN_ENC_KEY";

function setKey(): string {
  const key = randomBytes(32).toString("base64");
  process.env[ENV_VAR] = key;
  _resetKeyCacheForTests();
  return key;
}

function clearKey(): void {
  delete process.env[ENV_VAR];
  _resetKeyCacheForTests();
}

describe("token-crypto", () => {
  const originalEnv = process.env[ENV_VAR];
  const originalNodeEnv = process.env["NODE_ENV"];

  beforeEach(() => {
    setKey();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = originalEnv;
    if (originalNodeEnv === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = originalNodeEnv;
    _resetKeyCacheForTests();
  });

  it("roundtrips plaintext through encrypt → decrypt", () => {
    const plain = "athena-access-token-abc123.with.dots";
    const ct = encryptToken(plain);
    expect(decryptToken(ct)).toBe(plain);
  });

  it("produces ciphertext that does not contain the plaintext", () => {
    // The "tokens are encrypted before persistence" guarantee: a row
    // dump should never reveal the original value via substring search.
    const plain = "super-secret-refresh-token-xyz";
    const ct = encryptToken(plain);
    expect(ct).not.toContain(plain);
    expect(ct.startsWith("v1.")).toBe(true);
  });

  it("uses a fresh IV per call (same plaintext → different ciphertext)", () => {
    const plain = "same-input";
    const a = encryptToken(plain);
    const b = encryptToken(plain);
    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe(plain);
    expect(decryptToken(b)).toBe(plain);
  });

  it("throws (does not silently fall back) when the key env var is missing", () => {
    clearKey();
    expect(() => encryptToken("x")).toThrow(/EHR_TOKEN_ENC_KEY is required/);
    expect(() => decryptToken("v1.aa.bb.cc")).toThrow(
      /EHR_TOKEN_ENC_KEY is required/,
    );
  });

  it("escalates the error message in production when the key is missing", () => {
    clearKey();
    process.env["NODE_ENV"] = "production";
    expect(() => encryptToken("x")).toThrow(
      /refusing to start without an EHR token encryption key/,
    );
  });

  it("rejects a key that does not decode to exactly 32 bytes", () => {
    process.env[ENV_VAR] = Buffer.from("too-short").toString("base64");
    _resetKeyCacheForTests();
    expect(() => encryptToken("x")).toThrow(/must decode to exactly 32 bytes/);
  });

  it("rejects an unsupported ciphertext format header", () => {
    expect(() => decryptToken("v2.aa.bb.cc")).toThrow(TokenDecryptError);
    expect(() => decryptToken("not-a-ciphertext-at-all")).toThrow(
      TokenDecryptError,
    );
  });

  it("rejects ciphertext whose auth tag fails verification", () => {
    const ct = encryptToken("payload");
    const parts = ct.split(".");
    // Flip one byte of the ciphertext segment — GCM auth tag check
    // must fail and we must surface a generic error.
    const tampered = Buffer.from(parts[2]!, "base64url");
    tampered[0] = tampered[0]! ^ 0x01;
    const bad = [parts[0], parts[1], tampered.toString("base64url"), parts[3]].join(
      ".",
    );
    expect(() => decryptToken(bad)).toThrow(TokenDecryptError);
    try {
      decryptToken(bad);
    } catch (err) {
      const msg = (err as Error).message;
      // Error message must not echo the ciphertext, IV, or tag.
      expect(msg).not.toContain(parts[1]);
      expect(msg).not.toContain(parts[2]);
      expect(msg).not.toContain(parts[3]);
    }
  });

  it("rejects a ciphertext whose IV is the wrong length", () => {
    const shortIv = Buffer.alloc(8).toString("base64url");
    const ct = encryptToken("payload");
    const parts = ct.split(".");
    expect(() =>
      decryptToken([parts[0], shortIv, parts[2], parts[3]].join(".")),
    ).toThrow(TokenDecryptError);
  });

  it("looksLikeCiphertext recognizes v1 output and rejects plaintext", () => {
    expect(looksLikeCiphertext(encryptToken("x"))).toBe(true);
    expect(looksLikeCiphertext("plaintext-access-token")).toBe(false);
    expect(looksLikeCiphertext("v1plaintext")).toBe(false);
  });
});
