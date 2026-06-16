// Tests for session cookie SameSite/secure resolution. Cerner PowerChart
// can launch HaloNote inside a cross-site iframe; in that deployment the
// session cookie must be SameSite=None; Secure or the browser drops it
// on the iframe load and the resident hits an infinite /login redirect.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveSessionCookieMode,
  validateSessionCookieConfig,
} from "./auth";

const NODE_ENV = "NODE_ENV";
const SAMESITE = "SESSION_COOKIE_SAMESITE";

describe("resolveSessionCookieMode", () => {
  const saved = {
    nodeEnv: process.env[NODE_ENV],
    sameSite: process.env[SAMESITE],
  };

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

  it("defaults to lax + insecure when env is unset and NODE_ENV is not production", () => {
    process.env[NODE_ENV] = "development";
    expect(resolveSessionCookieMode()).toEqual({
      sameSite: "lax",
      secure: false,
    });
  });

  it("defaults to lax + secure in production when env is unset", () => {
    process.env[NODE_ENV] = "production";
    expect(resolveSessionCookieMode()).toEqual({
      sameSite: "lax",
      secure: true,
    });
  });

  it("treats empty string as unset (lax default)", () => {
    process.env[NODE_ENV] = "production";
    process.env[SAMESITE] = "";
    expect(resolveSessionCookieMode()).toEqual({
      sameSite: "lax",
      secure: true,
    });
  });

  it("accepts explicit lax", () => {
    process.env[NODE_ENV] = "development";
    process.env[SAMESITE] = "lax";
    expect(resolveSessionCookieMode()).toEqual({
      sameSite: "lax",
      secure: false,
    });
  });

  it("normalises case + whitespace", () => {
    process.env[NODE_ENV] = "production";
    for (const v of ["LAX", " Lax ", "lax"]) {
      process.env[SAMESITE] = v;
      expect(resolveSessionCookieMode().sameSite).toBe("lax");
    }
    for (const v of ["NONE", " None ", "none"]) {
      process.env[SAMESITE] = v;
      expect(resolveSessionCookieMode().sameSite).toBe("none");
    }
  });

  it("forces secure=true when sameSite=none, even in development", () => {
    // Browsers reject SameSite=None without Secure; if a dev opts in to
    // none they must run over HTTPS. We don't second-guess that here —
    // we just refuse to emit an invalid cookie attribute combo.
    process.env[NODE_ENV] = "development";
    process.env[SAMESITE] = "none";
    expect(resolveSessionCookieMode()).toEqual({
      sameSite: "none",
      secure: true,
    });
  });

  it("returns sameSite=none + secure=true in production", () => {
    process.env[NODE_ENV] = "production";
    process.env[SAMESITE] = "none";
    expect(resolveSessionCookieMode()).toEqual({
      sameSite: "none",
      secure: true,
    });
  });

  it("throws on unknown values", () => {
    process.env[NODE_ENV] = "production";
    for (const v of ["strict", "Strict", "true", "1", "yes", "non", "laxx"]) {
      process.env[SAMESITE] = v;
      expect(
        () => resolveSessionCookieMode(),
        `value ${JSON.stringify(v)} must throw`,
      ).toThrow(/SESSION_COOKIE_SAMESITE/);
    }
  });
});

describe("validateSessionCookieConfig", () => {
  const saved = {
    nodeEnv: process.env[NODE_ENV],
    sameSite: process.env[SAMESITE],
  };

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

  it("passes when env is unset", () => {
    expect(() => validateSessionCookieConfig()).not.toThrow();
  });

  it("passes in production with sameSite=none (secure forced on)", () => {
    process.env[NODE_ENV] = "production";
    process.env[SAMESITE] = "none";
    expect(() => validateSessionCookieConfig()).not.toThrow();
  });

  it("passes in development with sameSite=none (secure forced on)", () => {
    process.env[NODE_ENV] = "development";
    process.env[SAMESITE] = "none";
    expect(() => validateSessionCookieConfig()).not.toThrow();
  });

  it("propagates invalid-value errors so a typo fails startup, not a request", () => {
    process.env[NODE_ENV] = "production";
    process.env[SAMESITE] = "strict";
    expect(() => validateSessionCookieConfig()).toThrow(
      /SESSION_COOKIE_SAMESITE/,
    );
  });
});
