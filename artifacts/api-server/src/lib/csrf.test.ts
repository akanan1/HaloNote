import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import {
  CSRF_COOKIE,
  generateCsrfToken,
  isSafeMethod,
  setCsrfCookie,
  timingSafeStringEqual,
} from "./csrf";

describe("isSafeMethod", () => {
  it.each(["GET", "HEAD", "OPTIONS"])("considers %s safe", (m) => {
    expect(isSafeMethod(m)).toBe(true);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("considers %s unsafe", (m) => {
    expect(isSafeMethod(m)).toBe(false);
  });
});

describe("timingSafeStringEqual", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeStringEqual("abc", "abc")).toBe(true);
  });

  it("returns false for unequal strings of the same length", () => {
    expect(timingSafeStringEqual("abc", "abd")).toBe(false);
  });

  it("returns false for unequal-length strings without throwing", () => {
    expect(timingSafeStringEqual("abc", "ab")).toBe(false);
    expect(timingSafeStringEqual("ab", "abcd")).toBe(false);
  });

  it("returns false for empty + non-empty", () => {
    expect(timingSafeStringEqual("", "x")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(timingSafeStringEqual("", "")).toBe(true);
  });
});

describe("generateCsrfToken", () => {
  it("returns a 64-char hex string (32 bytes)", () => {
    const t = generateCsrfToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns distinct tokens across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) seen.add(generateCsrfToken());
    expect(seen.size).toBe(20);
  });
});

// CSRF cookie shares its SameSite/secure mode with the session cookie
// via SESSION_COOKIE_SAMESITE so iframe (Cerner SMART launch) deployments
// don't end up with a session but no CSRF cookie.
describe("setCsrfCookie cookie attributes", () => {
  const NODE_ENV = "NODE_ENV";
  const SAMESITE = "SESSION_COOKIE_SAMESITE";
  const saved = {
    nodeEnv: process.env[NODE_ENV],
    sameSite: process.env[SAMESITE],
  };

  function captureCookieOpts(): {
    res: Response;
    spy: ReturnType<typeof vi.fn>;
  } {
    const spy = vi.fn();
    const res = { cookie: spy } as unknown as Response;
    return { res, spy };
  }

  beforeEach(() => {
    delete process.env[NODE_ENV];
    delete process.env[SAMESITE];
  });

  afterEach(() => {
    if (saved.nodeEnv === undefined) delete process.env[NODE_ENV];
    else process.env[NODE_ENV] = saved.nodeEnv;
    if (saved.sameSite === undefined) delete process.env[SAMESITE];
    else process.env[SAMESITE] = saved.sameSite;
  });

  it("defaults to sameSite=lax, secure=false in development", () => {
    process.env[NODE_ENV] = "development";
    const { res, spy } = captureCookieOpts();
    setCsrfCookie(res, "tok");
    expect(spy).toHaveBeenCalledWith(
      CSRF_COOKIE,
      "tok",
      expect.objectContaining({
        sameSite: "lax",
        secure: false,
        httpOnly: false,
        path: "/",
      }),
    );
  });

  it("defaults to sameSite=lax, secure=true in production", () => {
    process.env[NODE_ENV] = "production";
    const { res, spy } = captureCookieOpts();
    setCsrfCookie(res, "tok");
    expect(spy.mock.calls[0]?.[2]).toMatchObject({
      sameSite: "lax",
      secure: true,
    });
  });

  it("uses sameSite=none, secure=true when SESSION_COOKIE_SAMESITE=none (production iframe launch)", () => {
    process.env[NODE_ENV] = "production";
    process.env[SAMESITE] = "none";
    const { res, spy } = captureCookieOpts();
    setCsrfCookie(res, "tok");
    expect(spy.mock.calls[0]?.[2]).toMatchObject({
      sameSite: "none",
      secure: true,
    });
  });

  it("forces secure=true when sameSite=none even in development", () => {
    process.env[NODE_ENV] = "development";
    process.env[SAMESITE] = "none";
    const { res, spy } = captureCookieOpts();
    setCsrfCookie(res, "tok");
    expect(spy.mock.calls[0]?.[2]).toMatchObject({
      sameSite: "none",
      secure: true,
    });
  });

  it("keeps httpOnly=false regardless of mode (SPA must read it)", () => {
    // Invariant: the CSRF cookie has to be readable from document.cookie
    // so the SPA can echo it in X-CSRF-Token. SameSite changes must not
    // accidentally tighten this.
    for (const mode of [undefined, "lax", "none"]) {
      if (mode === undefined) delete process.env[SAMESITE];
      else process.env[SAMESITE] = mode;
      const { res, spy } = captureCookieOpts();
      setCsrfCookie(res, "tok");
      expect(spy.mock.calls[0]?.[2]).toMatchObject({ httpOnly: false });
    }
  });
});
