import { describe, expect, it } from "vitest";
import { validateEhrProductionConfig } from "./ehr-prod-guard";

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return overrides as NodeJS.ProcessEnv;
}

describe("validateEhrProductionConfig", () => {
  it("is a no-op outside production", () => {
    expect(() =>
      validateEhrProductionConfig(env({ NODE_ENV: "development" })),
    ).not.toThrow();
    expect(() =>
      validateEhrProductionConfig(
        env({
          NODE_ENV: "test",
          ATHENA_FHIR_BASE_URL:
            "https://api.preview.platform.athenahealth.com/fhir/r4",
        }),
      ),
    ).not.toThrow();
  });

  it("rejects production boot with EHR_MODE unset", () => {
    expect(() =>
      validateEhrProductionConfig(env({ NODE_ENV: "production" })),
    ).toThrow(/EHR_MODE must be set/);
  });

  it("rejects production boot with EHR_MODE=mock", () => {
    expect(() =>
      validateEhrProductionConfig(
        env({ NODE_ENV: "production", EHR_MODE: "mock" }),
      ),
    ).toThrow(/not a real provider/);
  });

  it("rejects preview FHIR base in production", () => {
    expect(() =>
      validateEhrProductionConfig(
        env({
          NODE_ENV: "production",
          EHR_MODE: "athenahealth",
          ATHENA_FHIR_BASE_URL:
            "https://api.preview.platform.athenahealth.com/fhir/r4",
          ATHENA_TOKEN_URL:
            "https://api.platform.athenahealth.com/oauth2/v1/token",
          ATHENA_REDIRECT_URI: "https://example.com/api/auth/ehr/callback",
        }),
      ),
    ).toThrow(/sandbox host/);
  });

  it("rejects preview token URL in production", () => {
    expect(() =>
      validateEhrProductionConfig(
        env({
          NODE_ENV: "production",
          EHR_MODE: "athenahealth",
          ATHENA_FHIR_BASE_URL:
            "https://api.platform.athenahealth.com/fhir/r4",
          ATHENA_TOKEN_URL:
            "https://api.preview.platform.athenahealth.com/oauth2/v1/token",
          ATHENA_REDIRECT_URI: "https://example.com/api/auth/ehr/callback",
        }),
      ),
    ).toThrow(/sandbox host/);
  });

  it("rejects http redirect in production (non-localhost)", () => {
    expect(() =>
      validateEhrProductionConfig(
        env({
          NODE_ENV: "production",
          EHR_MODE: "athenahealth",
          ATHENA_FHIR_BASE_URL:
            "https://api.platform.athenahealth.com/fhir/r4",
          ATHENA_TOKEN_URL:
            "https://api.platform.athenahealth.com/oauth2/v1/token",
          ATHENA_REDIRECT_URI: "http://example.com/api/auth/ehr/callback",
        }),
      ),
    ).toThrow(/https:/);
  });

  it("accepts a well-formed production Athena config", () => {
    expect(() =>
      validateEhrProductionConfig(
        env({
          NODE_ENV: "production",
          EHR_MODE: "athenahealth",
          ATHENA_FHIR_BASE_URL:
            "https://api.platform.athenahealth.com/fhir/r4",
          ATHENA_TOKEN_URL:
            "https://api.platform.athenahealth.com/oauth2/v1/token",
          ATHENA_REDIRECT_URI: "https://halonote.app/api/auth/ehr/callback",
        }),
      ),
    ).not.toThrow();
  });
});
