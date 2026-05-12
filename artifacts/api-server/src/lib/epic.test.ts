import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createEpicClientMock = vi.fn();
vi.mock("@workspace/ehr/epic", () => ({
  createEpicClient: (...args: unknown[]) => createEpicClientMock(...args),
}));

import { getEpicClient, resetEpicClientCache } from "./epic";

const STORED_KEY = "-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----";

function setEpicEnv(overrides: Record<string, string | undefined> = {}): void {
  const base: Record<string, string> = {
    EPIC_FHIR_BASE_URL: "https://fhir.epic.example/api/FHIR/R4",
    EPIC_TOKEN_URL: "https://fhir.epic.example/oauth2/token",
    EPIC_CLIENT_ID: "client_abc",
    EPIC_PRIVATE_KEY: STORED_KEY,
    EPIC_ALGORITHM: "RS384",
    EPIC_KEY_ID: "key_1",
    EPIC_SCOPE: "system/DocumentReference.write",
    EPIC_AUDIENCE: "https://fhir.epic.example/oauth2/token",
  };
  for (const [k, v] of Object.entries({ ...base, ...overrides })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function clearEpicEnv(): void {
  for (const k of Object.keys(process.env).filter((k) => k.startsWith("EPIC_"))) {
    delete process.env[k];
  }
}

describe("getEpicClient", () => {
  beforeEach(() => {
    createEpicClientMock.mockReset();
    createEpicClientMock.mockReturnValue({ marker: "epic-client" });
    resetEpicClientCache();
  });

  afterEach(() => {
    clearEpicEnv();
    resetEpicClientCache();
  });

  it("reads EPIC_* env vars and passes them to createEpicClient", () => {
    setEpicEnv();
    getEpicClient();
    expect(createEpicClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        fhirBaseUrl: "https://fhir.epic.example/api/FHIR/R4",
        tokenUrl: "https://fhir.epic.example/oauth2/token",
        clientId: "client_abc",
        algorithm: "RS384",
        privateKey: STORED_KEY,
        keyId: "key_1",
        scope: "system/DocumentReference.write",
        audience: "https://fhir.epic.example/oauth2/token",
      }),
    );
  });

  it("caches the client across calls (singleton)", () => {
    setEpicEnv();
    getEpicClient();
    getEpicClient();
    getEpicClient();
    expect(createEpicClientMock).toHaveBeenCalledTimes(1);
  });

  it("throws when a required env var is missing", () => {
    setEpicEnv({ EPIC_CLIENT_ID: undefined });
    expect(() => getEpicClient()).toThrow(/EPIC_CLIENT_ID/);
  });

  it("rejects an unsupported algorithm", () => {
    setEpicEnv({ EPIC_ALGORITHM: "HS256" });
    expect(() => getEpicClient()).toThrow(/EPIC_ALGORITHM/);
  });

  it("normalizes escaped newlines in EPIC_PRIVATE_KEY", () => {
    setEpicEnv({
      EPIC_PRIVATE_KEY:
        "-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----",
    });
    getEpicClient();
    expect(createEpicClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ privateKey: STORED_KEY }),
    );
  });

  it("defaults algorithm to RS384 when EPIC_ALGORITHM is unset", () => {
    setEpicEnv({ EPIC_ALGORITHM: undefined });
    getEpicClient();
    expect(createEpicClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ algorithm: "RS384" }),
    );
  });

  it("omits optional fields when their env var is unset", () => {
    setEpicEnv({
      EPIC_AUDIENCE: undefined,
      EPIC_SCOPE: undefined,
      EPIC_KEY_ID: undefined,
    });
    getEpicClient();
    const call = createEpicClientMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(call.audience).toBeUndefined();
    expect(call.scope).toBeUndefined();
    expect(call.keyId).toBeUndefined();
  });
});
