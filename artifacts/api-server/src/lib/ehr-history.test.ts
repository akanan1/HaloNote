// Routing tests for getPatientHistory. The bug this guards against:
// before this, ehr-history.ts only consulted the Athena per-user
// client. A Cerner-launched resident has no Athena row, so it would
// fall through to the env-driven Athena/Epic global client — meaning
// they'd see another tenant's chart data on the patient panel. That
// is wrong-patient territory and must not regress.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ehr-user-client", () => ({
  getAthenahealthClientForUser: vi.fn(),
  getCernerClientForUser: vi.fn(),
}));

vi.mock("./athena", () => ({
  getAthenahealthClient: vi.fn(),
}));

vi.mock("./epic", () => ({
  getEpicClient: vi.fn(),
}));

import { getPatientHistory } from "./ehr-history";
import {
  getAthenahealthClientForUser,
  getCernerClientForUser,
} from "./ehr-user-client";
import { getAthenahealthClient } from "./athena";
import { getEpicClient } from "./epic";

const mockGetCerner = vi.mocked(getCernerClientForUser);
const mockGetAthena = vi.mocked(getAthenahealthClientForUser);
const mockGlobalAthena = vi.mocked(getAthenahealthClient);
const mockGlobalEpic = vi.mocked(getEpicClient);

// Returns a UserEhrClient-shaped stub whose FHIR `search` returns empty
// bundles. Only the identity of `fhir.search` matters — the spy lets us
// assert which client got used.
function fakeUserClient() {
  const search = vi.fn().mockResolvedValue({ resourceType: "Bundle", entry: [] });
  return {
    client: {
      fhir: { search },
      // unused by getPatientHistory but matches the UserEhrClient shape
      documentReference: {} as never,
      practitionerId: null,
    },
    search,
  };
}

describe("getPatientHistory routing", () => {
  const savedEhrMode = process.env["EHR_MODE"];

  beforeEach(() => {
    mockGetCerner.mockReset();
    mockGetAthena.mockReset();
    mockGlobalAthena.mockReset();
    mockGlobalEpic.mockReset();
    delete process.env["EHR_MODE"];
  });

  afterEach(() => {
    if (savedEhrMode === undefined) delete process.env["EHR_MODE"];
    else process.env["EHR_MODE"] = savedEhrMode;
  });

  it("uses the Cerner per-user client when the user has a Cerner connection", async () => {
    const cerner = fakeUserClient();
    mockGetCerner.mockResolvedValue(cerner.client as never);
    // Athena helper must not be consulted once Cerner has answered.
    mockGetAthena.mockResolvedValue(null);

    const result = await getPatientHistory("ext_pt_001", "usr_resident");

    expect(mockGetCerner).toHaveBeenCalledWith("usr_resident");
    expect(mockGetAthena).not.toHaveBeenCalled();
    expect(cerner.search).toHaveBeenCalled();
    expect(mockGlobalAthena).not.toHaveBeenCalled();
    expect(mockGlobalEpic).not.toHaveBeenCalled();
    expect(result).toEqual({ problems: [], medications: [], allergies: [] });
  });

  it("falls back to the Athena per-user client when no Cerner connection exists", async () => {
    mockGetCerner.mockResolvedValue(null);
    const athena = fakeUserClient();
    mockGetAthena.mockResolvedValue(athena.client as never);

    await getPatientHistory("ext_pt_002", "usr_athena_user");

    expect(mockGetCerner).toHaveBeenCalledWith("usr_athena_user");
    expect(mockGetAthena).toHaveBeenCalledWith("usr_athena_user");
    expect(athena.search).toHaveBeenCalled();
    // The env-driven global client must NOT be consulted when a per-user
    // client is available — that's exactly the wrong-tenant bug we fixed.
    expect(mockGlobalAthena).not.toHaveBeenCalled();
    expect(mockGlobalEpic).not.toHaveBeenCalled();
  });

  it("falls through to mock when the user has neither connection and EHR_MODE is unset", async () => {
    mockGetCerner.mockResolvedValue(null);
    mockGetAthena.mockResolvedValue(null);

    const result = await getPatientHistory("pt_001", "usr_unconnected");

    // pt_001 is a known mock entry — non-empty arrays prove the mock
    // path ran (rather than a global client call).
    expect(result.problems.length).toBeGreaterThan(0);
    expect(mockGlobalAthena).not.toHaveBeenCalled();
    expect(mockGlobalEpic).not.toHaveBeenCalled();
  });

  it("does NOT consult per-user clients when called without a userId", async () => {
    // Anonymous path (e.g. a server-side preview without a logged-in
    // user). Stays on the env-driven mock path by default.
    const result = await getPatientHistory("pt_002");

    expect(mockGetCerner).not.toHaveBeenCalled();
    expect(mockGetAthena).not.toHaveBeenCalled();
    expect(result).toBeDefined();
  });
});
