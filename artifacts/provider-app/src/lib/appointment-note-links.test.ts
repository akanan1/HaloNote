import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _allClaimsForTests,
  claimAppointment,
  clearAppointmentClaim,
  getAppointmentClaim,
} from "./appointment-note-links";

describe("appointment-note-links", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("round-trips a claim through localStorage", () => {
    const claim = claimAppointment("appt-1", "pt_001");
    expect(claim.appointmentId).toBe("appt-1");
    expect(claim.patientId).toBe("pt_001");
    expect(typeof claim.claimedAt).toBe("string");

    const fetched = getAppointmentClaim("appt-1");
    expect(fetched).not.toBeNull();
    expect(fetched!.patientId).toBe("pt_001");
  });

  it("returns null for an unknown appointment id", () => {
    expect(getAppointmentClaim("nope")).toBeNull();
  });

  it("clearAppointmentClaim removes the row", () => {
    claimAppointment("appt-2", "pt_002");
    expect(getAppointmentClaim("appt-2")).not.toBeNull();
    clearAppointmentClaim("appt-2");
    expect(getAppointmentClaim("appt-2")).toBeNull();
  });

  it("ignores entries older than 7 days", () => {
    // Manually seed a stale row — bypasses the helper's now() stamp.
    const stale = {
      appointmentId: "appt-stale",
      patientId: "pt_x",
      claimedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    };
    window.localStorage.setItem(
      "halo:appt-claim:appt-stale",
      JSON.stringify(stale),
    );
    expect(getAppointmentClaim("appt-stale")).toBeNull();
  });

  it("ignores malformed JSON without throwing", () => {
    window.localStorage.setItem("halo:appt-claim:bad", "{not-json");
    expect(getAppointmentClaim("bad")).toBeNull();
  });

  it("ignores entries missing required fields", () => {
    window.localStorage.setItem(
      "halo:appt-claim:partial",
      JSON.stringify({ appointmentId: "partial" }),
    );
    expect(getAppointmentClaim("partial")).toBeNull();
  });

  it("_allClaimsForTests enumerates only halo:appt-claim:* keys", () => {
    claimAppointment("appt-3", "pt_003");
    claimAppointment("appt-4", "pt_004");
    // Unrelated key — must not appear in results.
    window.localStorage.setItem("unrelated-key", "x");
    const all = _allClaimsForTests();
    const ids = all.map((c) => c.appointmentId).sort();
    expect(ids).toEqual(["appt-3", "appt-4"]);
  });
});
