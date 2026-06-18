import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @workspace/db so importing ehr-oauth doesn't require a live DB.
vi.mock("@workspace/db", () => {
  return {
    getDb: () => ({}),
    ehrConnectionsTable: {},
    ehrOauthStatesTable: {},
    usersTable: {},
  };
});

import { introspectToken } from "./ehr-oauth";

const baseCfg = {
  authorizeUrl: "https://idp.test/oauth2/v1/authorize",
  tokenUrl: "https://idp.test/oauth2/v1/token",
  fhirBaseUrl: "https://fhir.test/r4",
  clientId: "client-1",
  clientSecret: "secret-xyz",
  scope: "openid",
  redirectUri: "https://app.test/cb",
  introspectUrl: "https://idp.test/oauth2/v1/introspect",
};

describe("introspectToken", () => {
  let fetchSpy = vi.spyOn(globalThis, "fetch");

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("posts Basic-auth'd introspect request and returns parsed body", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          active: true,
          scope: "openid fhirUser user/DocumentReference.write",
          exp: 1_700_000_000,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const out = await introspectToken(baseCfg, "access-token-123");
    expect(out.active).toBe(true);
    expect(out.scope).toContain("DocumentReference.write");

    const call = fetchSpy.mock.calls[0]!;
    expect(call[0]).toBe(baseCfg.introspectUrl);
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    // Basic auth header present and not echoing raw creds in the URL.
    expect(headers["authorization"]).toMatch(/^Basic /);
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const body = String(init.body);
    expect(body).toContain("token=access-token-123");
    expect(body).toContain("token_type_hint=access_token");
  });

  it("throws OauthExchangeError on non-2xx without echoing body", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("scope=secret-leaking-payload", {
        status: 401,
        statusText: "Unauthorized",
      }),
    );
    await expect(introspectToken(baseCfg, "tok")).rejects.toMatchObject({
      name: "OauthExchangeError",
      status: 401,
    });
    // Make sure the body wasn't pulled into the error message.
    await expect(introspectToken(baseCfg, "tok")).rejects.not.toMatchObject({
      message: expect.stringContaining("secret-leaking-payload"),
    });
  });

  it("throws if introspectUrl is missing from cfg", async () => {
    const cfgNoUrl = { ...baseCfg, introspectUrl: undefined };
    await expect(
      introspectToken(cfgNoUrl as never, "tok"),
    ).rejects.toThrow(/introspectUrl/);
  });
});
