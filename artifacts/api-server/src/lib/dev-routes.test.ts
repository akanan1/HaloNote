// Tests for the dev-routes gate. The function is called at
// module-import time by every dev-only mount site
// (routes/auth.ts dev-login, routes/ehr-oauth.ts dev-start,
// routes/index.ts dev-sandbox), so its behavior — especially its
// fail-closed throw on a misconfigured prod deploy — is what stops
// an unauthenticated session-minting endpoint from quietly shipping.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetForTests, devRoutesEnabled } from "./dev-routes";

const NODE_ENV = "NODE_ENV";
const FLAG = "ALLOW_DEV_ROUTES";

describe("devRoutesEnabled", () => {
  const saved = {
    nodeEnv: process.env[NODE_ENV],
    flag: process.env[FLAG],
  };

  beforeEach(() => {
    delete process.env[NODE_ENV];
    delete process.env[FLAG];
    _resetForTests();
  });

  afterEach(() => {
    if (saved.nodeEnv === undefined) delete process.env[NODE_ENV];
    else process.env[NODE_ENV] = saved.nodeEnv;
    if (saved.flag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved.flag;
    _resetForTests();
    vi.restoreAllMocks();
  });

  it("returns true in development when ALLOW_DEV_ROUTES=1", () => {
    process.env[NODE_ENV] = "development";
    process.env[FLAG] = "1";
    expect(devRoutesEnabled()).toBe(true);
  });

  it("returns true in test env when ALLOW_DEV_ROUTES=1", () => {
    // The api-server's E2E setup runs with NODE_ENV=test and the
    // flag on — this guarantees that still works.
    process.env[NODE_ENV] = "test";
    process.env[FLAG] = "1";
    expect(devRoutesEnabled()).toBe(true);
  });

  it("defaults to false in development when ALLOW_DEV_ROUTES is unset", () => {
    process.env[NODE_ENV] = "development";
    expect(devRoutesEnabled()).toBe(false);
  });

  it("defaults to false in development when ALLOW_DEV_ROUTES is anything other than '1'", () => {
    process.env[NODE_ENV] = "development";
    // Only the literal "1" enables — "true"/"yes"/etc are NOT
    // treated as on, by design (opt-in must be explicit).
    for (const v of ["true", "yes", "on", "0", "false", ""]) {
      process.env[FLAG] = v;
      expect(devRoutesEnabled()).toBe(false);
    }
  });

  it("returns false in production when ALLOW_DEV_ROUTES is unset", () => {
    process.env[NODE_ENV] = "production";
    expect(devRoutesEnabled()).toBe(false);
  });

  it("THROWS in production when ALLOW_DEV_ROUTES=1 (fail-closed)", () => {
    process.env[NODE_ENV] = "production";
    process.env[FLAG] = "1";
    expect(() => devRoutesEnabled()).toThrow(
      /ALLOW_DEV_ROUTES is set in a NODE_ENV=production deployment/,
    );
  });

  it("THROWS in production for any non-opt-out truthy value", () => {
    process.env[NODE_ENV] = "production";
    for (const v of ["true", "yes", "on", "enable", "1", " 1 "]) {
      process.env[FLAG] = v;
      expect(
        () => devRoutesEnabled(),
        `value ${JSON.stringify(v)} must throw in prod`,
      ).toThrow(/must NEVER be enabled in production/);
    }
  });

  it("does NOT throw in production for explicit opt-out values", () => {
    process.env[NODE_ENV] = "production";
    // An env template carrying the variable with one of these
    // explicit-off values must let prod boot normally.
    for (const v of ["", "0", "false", "FALSE", "no", "off"]) {
      process.env[FLAG] = v;
      expect(
        () => devRoutesEnabled(),
        `value ${JSON.stringify(v)} must be safe in prod`,
      ).not.toThrow();
      expect(devRoutesEnabled()).toBe(false);
    }
  });

  it("error message names the bad var and offers a remediation", () => {
    // A future maintainer relying on the message text to know what
    // to fix in deploy logs.
    process.env[NODE_ENV] = "production";
    process.env[FLAG] = "1";
    try {
      devRoutesEnabled();
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("ALLOW_DEV_ROUTES");
      expect(msg).toContain("NODE_ENV=production");
      expect(msg).toMatch(/Unset|set it to/);
    }
  });

  it("never logs the warning when running in production", async () => {
    // Belt-and-suspenders: even on the safe (opt-out) prod path, we
    // must not emit the dev-routes-mounted warning.
    process.env[NODE_ENV] = "production";
    process.env[FLAG] = "0";
    const { logger } = await import("./logger");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    expect(devRoutesEnabled()).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns exactly once across multiple enabled calls", async () => {
    process.env[NODE_ENV] = "development";
    process.env[FLAG] = "1";
    const { logger } = await import("./logger");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    devRoutesEnabled();
    devRoutesEnabled();
    devRoutesEnabled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
