// Routing tests for getSchedule. Same guard as ehr-history.test.ts:
// Cerner-launched residents must hit the Cerner per-user client, not
// fall through to the env-driven global Athena/Epic client and see a
// stranger's schedule.

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

import { getSchedule } from "./ehr-schedule";
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

function fakeUserClient() {
  const search = vi.fn().mockResolvedValue({ resourceType: "Bundle", entry: [] });
  return {
    client: {
      fhir: { search },
      documentReference: {} as never,
      practitionerId: null,
    },
    search,
  };
}

describe("getSchedule routing", () => {
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
    mockGetAthena.mockResolvedValue(null);

    await getSchedule("prac_resident", "2026-05-18", "usr_resident");

    expect(mockGetCerner).toHaveBeenCalledWith("usr_resident");
    expect(mockGetAthena).not.toHaveBeenCalled();
    expect(cerner.search).toHaveBeenCalled();
    expect(mockGlobalAthena).not.toHaveBeenCalled();
    expect(mockGlobalEpic).not.toHaveBeenCalled();
  });

  it("falls back to the Athena per-user client when no Cerner connection exists", async () => {
    mockGetCerner.mockResolvedValue(null);
    const athena = fakeUserClient();
    mockGetAthena.mockResolvedValue(athena.client as never);

    await getSchedule("prac_athena", "2026-05-18", "usr_athena_user");

    expect(mockGetCerner).toHaveBeenCalledWith("usr_athena_user");
    expect(mockGetAthena).toHaveBeenCalledWith("usr_athena_user");
    expect(athena.search).toHaveBeenCalled();
    expect(mockGlobalAthena).not.toHaveBeenCalled();
    expect(mockGlobalEpic).not.toHaveBeenCalled();
  });

  it("returns the mock roster when the user has neither connection and EHR_MODE is unset", async () => {
    mockGetCerner.mockResolvedValue(null);
    mockGetAthena.mockResolvedValue(null);

    // Pick a weekday (Mon=2026-05-18) so the mock returns a non-empty
    // roster — non-empty result proves we landed on the mock branch
    // instead of a global client call.
    const result = await getSchedule(
      "prac_unconnected",
      "2026-05-18",
      "usr_unconnected",
    );

    expect(result.length).toBeGreaterThan(0);
    expect(mockGlobalAthena).not.toHaveBeenCalled();
    expect(mockGlobalEpic).not.toHaveBeenCalled();
  });

  it("does NOT consult per-user clients when called without a userId", async () => {
    const result = await getSchedule("prac_anon", "2026-05-18");

    expect(mockGetCerner).not.toHaveBeenCalled();
    expect(mockGetAthena).not.toHaveBeenCalled();
    expect(result.length).toBeGreaterThan(0);
  });
});
