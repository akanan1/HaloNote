import { describe, it, expect, vi } from "vitest";
import { OAuth2TokenProvider } from "./oauth2";

interface FakeCallContext {
  url: string;
  body: string;
  authorization: string | null;
}

function makeProvider(
  responses: Array<{
    status?: number;
    body: unknown;
    headers?: Record<string, string>;
  }>,
  config: {
    clientId?: string;
    clientSecret?: string;
    scope?: string;
  } = {},
) {
  const calls: FakeCallContext[] = [];
  let i = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);
    calls.push({ url, body, authorization: headers.get("authorization") });
    const r = responses[i++] ?? responses[responses.length - 1]!;
    return new Response(
      typeof r.body === "string" ? r.body : JSON.stringify(r.body),
      {
        status: r.status ?? 200,
        headers: r.headers ?? { "content-type": "application/json" },
      },
    );
  });

  const provider = new OAuth2TokenProvider({
    tokenUrl: "https://example.test/oauth/token",
    clientId: config.clientId ?? "client-abc",
    clientSecret: config.clientSecret ?? "secret-xyz",
    ...(config.scope !== undefined ? { scope: config.scope } : {}),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  return { provider, fetchImpl, calls };
}

describe("OAuth2TokenProvider", () => {
  it("returns the token and includes scope in the request body when configured", async () => {
    const { provider, calls } = makeProvider(
      [{ body: { access_token: "tok-1", token_type: "Bearer", expires_in: 3600 } }],
      { scope: "patient/*.read" },
    );
    const t = await provider.getToken();
    expect(t).toBe("tok-1");
    expect(calls[0]!.body).toContain("grant_type=client_credentials");
    expect(calls[0]!.body).toContain("scope=patient");
  });

  it("uses RFC-6749 form-urlencoded encoding in HTTP Basic (space → +, ! encoded)", async () => {
    const { provider, calls } = makeProvider(
      [{ body: { access_token: "x", token_type: "Bearer", expires_in: 3600 } }],
      { clientId: "id with space", clientSecret: "p+a!b" },
    );
    await provider.getToken();
    const basic = calls[0]!.authorization!;
    expect(basic.startsWith("Basic ")).toBe(true);
    const decoded = Buffer.from(basic.slice(6), "base64").toString("utf8");
    // URLSearchParams encoding: space → "+", "!" → "%21", "+" → "%2B".
    expect(decoded).toBe("id+with+space:p%2Ba%21b");
  });

  it("validates expires_in: missing → default 300s, NaN string → 300s, valid string → coerced", async () => {
    const cases = [
      { resp: { access_token: "a", token_type: "Bearer" }, expectedSec: 300 },
      {
        resp: { access_token: "a", token_type: "Bearer", expires_in: "abc" },
        expectedSec: 300,
      },
      {
        resp: { access_token: "a", token_type: "Bearer", expires_in: "120" },
        expectedSec: 120,
      },
      {
        resp: { access_token: "a", token_type: "Bearer", expires_in: -5 },
        expectedSec: 300,
      },
      {
        resp: {
          access_token: "a",
          token_type: "Bearer",
          expires_in: 999_999_999,
        },
        expectedSec: 86_400,
      },
    ];
    for (const c of cases) {
      const before = Date.now();
      const { provider } = makeProvider([{ body: c.resp }]);
      const acc = await provider.getAccessToken();
      const ttl = acc.expiresAt - before;
      // Allow a generous fuzz window for test runtime.
      expect(ttl).toBeGreaterThanOrEqual(c.expectedSec * 1000 - 50);
      expect(ttl).toBeLessThanOrEqual(c.expectedSec * 1000 + 250);
    }
  });

  it("caches tokens and does not re-fetch within the validity window", async () => {
    const { provider, fetchImpl } = makeProvider([
      { body: { access_token: "tok-1", token_type: "Bearer", expires_in: 3600 } },
    ]);
    await provider.getToken();
    await provider.getToken();
    await provider.getToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("invalidate() forces a refetch on next call", async () => {
    const { provider, fetchImpl } = makeProvider([
      { body: { access_token: "tok-1", token_type: "Bearer", expires_in: 3600 } },
      { body: { access_token: "tok-2", token_type: "Bearer", expires_in: 3600 } },
    ]);
    expect(await provider.getToken()).toBe("tok-1");
    provider.invalidate();
    expect(await provider.getToken()).toBe("tok-2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("concurrent calls deduplicate to a single fetch (inflight)", async () => {
    const { provider, fetchImpl } = makeProvider([
      { body: { access_token: "tok-1", token_type: "Bearer", expires_in: 3600 } },
    ]);
    const [a, b, c] = await Promise.all([
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
    ]);
    expect([a, b, c]).toEqual(["tok-1", "tok-1", "tok-1"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sanitizes error responses — uses error/error_description, not raw body", async () => {
    const { provider } = makeProvider([
      {
        status: 401,
        body: {
          error: "invalid_client",
          error_description: "client secret is wrong",
          client_assertion: "secret-jwt-do-not-log",
        },
      },
    ]);
    await expect(provider.getToken()).rejects.toThrow(
      /invalid_client: client secret is wrong/,
    );
    await expect(provider.getToken()).rejects.not.toThrow(/secret-jwt-do-not-log/);
  });

  it("non-JSON error body is discarded, not echoed", async () => {
    const { provider } = makeProvider([
      {
        status: 500,
        body: "<html><body>boom — secret-config-string</body></html>",
        headers: { "content-type": "text/html" },
      },
    ]);
    const err = await provider.getToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/500/);
    expect((err as Error).message).not.toMatch(/secret-config-string/);
  });
});
