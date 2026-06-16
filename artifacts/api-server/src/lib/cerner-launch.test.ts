// Unit tests for the pure / config-shape bits of cerner-launch.
// `upsertCernerPatientFromLaunch` is exercised end-to-end by the
// callback path; it's not unit-tested here because it touches FHIR +
// DB and is more usefully covered by an integration test on a
// throwaway DB (deferred — same posture as the existing OAuth
// integration tests in this package).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildLaunchReturnPath,
  cernerConfig,
  isAllowedIssuer,
  isCernerConfigured,
  isValidLaunchToken,
} from "./cerner-launch";

const REQUIRED_VARS = [
  "CERNER_FHIR_BASE_URL",
  "CERNER_AUTHORIZE_URL",
  "CERNER_TOKEN_URL",
  "CERNER_CLIENT_ID",
  "CERNER_REDIRECT_URI",
];

function saveEnv(): Record<string, string | undefined> {
  return Object.fromEntries(
    [...REQUIRED_VARS, "CERNER_CLIENT_SECRET", "CERNER_SCOPE"].map((k) => [
      k,
      process.env[k],
    ]),
  );
}

function restoreEnv(saved: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function configureSandbox() {
  process.env["CERNER_FHIR_BASE_URL"] =
    "https://fhir-ehr-code.cerner.com/r4/ec2458f2-1e24-41c8-b71b-0e701af7583d";
  process.env["CERNER_AUTHORIZE_URL"] =
    "https://authorization.cerner.com/tenants/ec2458f2-1e24-41c8-b71b-0e701af7583d/protocols/oauth2/profiles/smart-v1/personas/provider/authorize";
  process.env["CERNER_TOKEN_URL"] =
    "https://authorization.cerner.com/tenants/ec2458f2-1e24-41c8-b71b-0e701af7583d/protocols/oauth2/profiles/smart-v1/token";
  process.env["CERNER_CLIENT_ID"] = "test-client-id";
  process.env["CERNER_REDIRECT_URI"] =
    "https://halonote.example/api/auth/ehr/callback";
}

describe("isCernerConfigured", () => {
  const saved = saveEnv();
  beforeEach(() => {
    for (const k of REQUIRED_VARS) delete process.env[k];
  });
  afterEach(() => restoreEnv(saved));

  it("returns true when every required env var is set", () => {
    configureSandbox();
    expect(isCernerConfigured()).toBe(true);
  });

  it("returns false when any required env var is missing", () => {
    for (const missing of REQUIRED_VARS) {
      configureSandbox();
      delete process.env[missing];
      expect(isCernerConfigured(), `missing ${missing}`).toBe(false);
    }
  });

  it("doesn't require CLIENT_SECRET (public clients are allowed)", () => {
    configureSandbox();
    delete process.env["CERNER_CLIENT_SECRET"];
    expect(isCernerConfigured()).toBe(true);
  });
});

describe("isAllowedIssuer", () => {
  const saved = saveEnv();
  beforeEach(() => configureSandbox());
  afterEach(() => restoreEnv(saved));

  it("matches the configured FHIR base exactly", () => {
    expect(
      isAllowedIssuer(
        "https://fhir-ehr-code.cerner.com/r4/ec2458f2-1e24-41c8-b71b-0e701af7583d",
      ),
    ).toBe(true);
  });

  it("tolerates a trailing slash on either side", () => {
    expect(
      isAllowedIssuer(
        "https://fhir-ehr-code.cerner.com/r4/ec2458f2-1e24-41c8-b71b-0e701af7583d/",
      ),
    ).toBe(true);
  });

  it("rejects a different tenant id on the same host", () => {
    expect(
      isAllowedIssuer(
        "https://fhir-ehr-code.cerner.com/r4/0000-aaaa-bbbb-cccc-dddd-attacker",
      ),
    ).toBe(false);
  });

  it("rejects an entirely different host", () => {
    expect(
      isAllowedIssuer("https://attacker.example/r4/whatever"),
    ).toBe(false);
  });

  it("rejects empty / missing / non-string values", () => {
    expect(isAllowedIssuer(undefined)).toBe(false);
    expect(isAllowedIssuer(null)).toBe(false);
    expect(isAllowedIssuer("")).toBe(false);
    expect(isAllowedIssuer(123)).toBe(false);
  });

  it("returns false when CERNER_FHIR_BASE_URL is unset (fail closed)", () => {
    delete process.env["CERNER_FHIR_BASE_URL"];
    expect(
      isAllowedIssuer(
        "https://fhir-ehr-code.cerner.com/r4/ec2458f2-1e24-41c8-b71b-0e701af7583d",
      ),
    ).toBe(false);
  });
});

describe("isValidLaunchToken", () => {
  it("accepts a typical opaque launch token", () => {
    expect(isValidLaunchToken("abc123-launch-token-xyz")).toBe(true);
  });

  it("rejects empty / missing / non-string", () => {
    expect(isValidLaunchToken(undefined)).toBe(false);
    expect(isValidLaunchToken("")).toBe(false);
    expect(isValidLaunchToken(null)).toBe(false);
    expect(isValidLaunchToken(42)).toBe(false);
  });

  it("rejects absurdly long tokens (defense against URL flooding)", () => {
    expect(isValidLaunchToken("x".repeat(2048))).toBe(false);
    expect(isValidLaunchToken("x".repeat(2047))).toBe(true);
  });
});

describe("buildLaunchReturnPath", () => {
  it("builds NewNote URL with patient + encounter context", () => {
    expect(
      buildLaunchReturnPath({
        internalPatientId: "pt_abc",
        externalPatientId: "12345",
        encounterId: "67890",
      }),
    ).toBe(
      "/patients/pt_abc/notes/new?ehrId=12345&encounterId=67890&fromLaunch=1",
    );
  });

  it("omits encounter when not provided", () => {
    expect(
      buildLaunchReturnPath({
        internalPatientId: "pt_abc",
        externalPatientId: "12345",
        encounterId: null,
      }),
    ).toBe("/patients/pt_abc/notes/new?ehrId=12345&fromLaunch=1");
  });

  it("URL-encodes the external patient id", () => {
    const out = buildLaunchReturnPath({
      internalPatientId: "pt_abc",
      externalPatientId: "pt with space&amp",
      encounterId: null,
    });
    expect(out).not.toContain(" ");
    expect(out).toContain("ehrId=pt+with+space");
    expect(out).toContain("amp");
  });
});

describe("cernerConfig", () => {
  const saved = saveEnv();
  beforeEach(() => configureSandbox());
  afterEach(() => restoreEnv(saved));

  it("returns the full config when env is populated", () => {
    const cfg = cernerConfig();
    expect(cfg.fhirBaseUrl).toContain("fhir-ehr-code.cerner.com");
    expect(cfg.authorizeUrl).toContain("/authorize");
    expect(cfg.tokenUrl).toContain("/token");
    expect(cfg.clientId).toBe("test-client-id");
    expect(cfg.redirectUri).toBe(
      "https://halonote.example/api/auth/ehr/callback",
    );
    expect(cfg.scope).toContain("launch");
    expect(cfg.scope).toContain("offline_access");
  });

  it("treats empty CLIENT_SECRET as a public client (empty string in config)", () => {
    delete process.env["CERNER_CLIENT_SECRET"];
    expect(cernerConfig().clientSecret).toBe("");
  });

  it("preserves a non-empty CLIENT_SECRET for confidential clients", () => {
    process.env["CERNER_CLIENT_SECRET"] = "shh";
    expect(cernerConfig().clientSecret).toBe("shh");
  });

  it("throws clearly when a required var is missing", () => {
    delete process.env["CERNER_TOKEN_URL"];
    expect(() => cernerConfig()).toThrow(
      /CERNER_TOKEN_URL is required for the Cerner SMART flow/,
    );
  });

  it("supplies a sensible default scope when CERNER_SCOPE is unset", () => {
    delete process.env["CERNER_SCOPE"];
    const cfg = cernerConfig();
    expect(cfg.scope).toContain("launch");
    expect(cfg.scope).toContain("offline_access");
    expect(cfg.scope).toContain("user/Patient.read");
  });
});
