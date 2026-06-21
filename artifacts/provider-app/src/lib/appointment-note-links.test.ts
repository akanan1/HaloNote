import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above import statements at parse time, so the mock
// fixture has to be hoisted too — otherwise `customFetchMock` is in the
// TDZ when the factory runs.
const { customFetchMock } = vi.hoisted(() => ({ customFetchMock: vi.fn() }));
vi.mock("@workspace/api-client-react", () => ({
  customFetch: customFetchMock,
}));

import {
  claimAppointment,
  clearAppointmentClaim,
  clearLegacyLocalClaims,
  listMyAppointmentClaims,
} from "./appointment-note-links";

describe("appointment-note-links — API wrappers", () => {
  beforeEach(() => {
    customFetchMock.mockReset();
  });

  it("listMyAppointmentClaims unwraps the { data } envelope", async () => {
    customFetchMock.mockResolvedValueOnce({
      data: [
        {
          appointmentId: "appt-1",
          patientId: "pt_1",
          claimedAt: "2026-06-18T10:00:00Z",
          expiresAt: "2026-06-25T10:00:00Z",
        },
      ],
    });
    const out = await listMyAppointmentClaims();
    expect(out).toHaveLength(1);
    expect(out[0]!.appointmentId).toBe("appt-1");
    expect(customFetchMock).toHaveBeenCalledWith("/api/appointment-claims/mine");
  });

  it("claimAppointment POSTs the JSON body", async () => {
    customFetchMock.mockResolvedValueOnce({
      appointmentId: "appt-2",
      patientId: "pt_2",
      claimedAt: "x",
      expiresAt: "y",
    });
    await claimAppointment("appt-2", "pt_2");
    const [url, init] = customFetchMock.mock.calls[0]!;
    expect(url).toBe("/api/appointment-claims");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      appointmentId: "appt-2",
      patientId: "pt_2",
    });
  });

  it("clearAppointmentClaim DELETEs and url-encodes the appointment id", async () => {
    customFetchMock.mockResolvedValueOnce(undefined);
    await clearAppointmentClaim("appt with/slash");
    const [url, init] = customFetchMock.mock.calls[0]!;
    expect(url).toBe(
      "/api/appointment-claims/appt%20with%2Fslash",
    );
    expect(init.method).toBe("DELETE");
  });
});

describe("clearLegacyLocalClaims", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("wipes all halo:appt-claim:* keys but leaves unrelated keys alone", () => {
    window.localStorage.setItem(
      "halo:appt-claim:appt-1",
      JSON.stringify({ appointmentId: "appt-1", patientId: "pt_1" }),
    );
    window.localStorage.setItem(
      "halo:appt-claim:appt-2",
      JSON.stringify({ appointmentId: "appt-2", patientId: "pt_2" }),
    );
    window.localStorage.setItem("unrelated", "keep-me");

    clearLegacyLocalClaims();

    expect(window.localStorage.getItem("halo:appt-claim:appt-1")).toBeNull();
    expect(window.localStorage.getItem("halo:appt-claim:appt-2")).toBeNull();
    expect(window.localStorage.getItem("unrelated")).toBe("keep-me");
  });

  it("is safe to call when localStorage is empty", () => {
    expect(() => clearLegacyLocalClaims()).not.toThrow();
  });
});
