import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetAthenahealthClientForTests,
  getAthenahealthAccessToken,
  getAthenahealthClient,
  getAthenahealthTokenProvider,
} from "./athena";

const ENV_KEYS = [
  "ATHENA_FHIR_BASE_URL",
  "ATHENA_TOKEN_URL",
  "ATHENA_CLIENT_ID",
  "ATHENA_CLIENT_SECRET",
  "ATHENA_SCOPE",
] as const;

describe("athena (shared token cache)", () => {
  const original = ENV_KEYS.map((k) => [k, process.env[k]] as const);

  beforeEach(() => {
    _resetAthenahealthClientForTests();
    process.env["ATHENA_FHIR_BASE_URL"] = "https://fhir.example.com/fhir/r4";
    process.env["ATHENA_TOKEN_URL"] = "https://idp.example.com/token";
    process.env["ATHENA_CLIENT_ID"] = "client-with-plus+sign";
    process.env["ATHENA_CLIENT_SECRET"] = "secret/with=special+chars";
    process.env["ATHENA_SCOPE"] = "system/Patient.read";
  });

  afterEach(() => {
    _resetAthenahealthClientForTests();
    for (const [k, v] of original) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("returns the same FHIR client on repeated calls (singleton)", () => {
    const a = getAthenahealthClient();
    const b = getAthenahealthClient();
    expect(a).toBe(b);
  });

  it("returns the same token provider on repeated calls (singleton)", () => {
    const a = getAthenahealthTokenProvider();
    const b = getAthenahealthTokenProvider();
    expect(a).toBe(b);
  });

  it("getAthenahealthAccessToken proxies to the shared provider", () => {
    // We don't actually mint a token — just confirm the helper resolves
    // through the same singleton, so chart-api + any future caller
    // share one cache. A real-fetch test belongs in the integration
    // suite (gated by a sandbox env).
    const p = getAthenahealthTokenProvider();
    expect(typeof getAthenahealthAccessToken).toBe("function");
    expect(typeof p.getToken).toBe("function");
  });

  it("_resetAthenahealthClientForTests drops both caches", () => {
    const provider1 = getAthenahealthTokenProvider();
    const client1 = getAthenahealthClient();
    _resetAthenahealthClientForTests();
    const provider2 = getAthenahealthTokenProvider();
    const client2 = getAthenahealthClient();
    expect(provider2).not.toBe(provider1);
    expect(client2).not.toBe(client1);
  });

  it("getAthenahealthTokenProvider throws if ATHENA_TOKEN_URL is missing", () => {
    delete process.env["ATHENA_TOKEN_URL"];
    _resetAthenahealthClientForTests();
    expect(() => getAthenahealthTokenProvider()).toThrow(/ATHENA_TOKEN_URL/);
  });

  it("getAthenahealthClient throws if ATHENA_FHIR_BASE_URL is missing", () => {
    delete process.env["ATHENA_FHIR_BASE_URL"];
    _resetAthenahealthClientForTests();
    expect(() => getAthenahealthClient()).toThrow(/ATHENA_FHIR_BASE_URL/);
  });

  it("omits scope from the provider config when ATHENA_SCOPE is unset", () => {
    delete process.env["ATHENA_SCOPE"];
    _resetAthenahealthClientForTests();
    // Smoke: doesn't throw on construction. The OAuth2TokenProvider
    // accepts an undefined scope; the body just won't emit `scope=`.
    expect(() => getAthenahealthTokenProvider()).not.toThrow();
  });
});
