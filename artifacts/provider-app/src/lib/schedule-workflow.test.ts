import { describe, expect, it } from "vitest";
import {
  deriveWorkflowStatus,
  workflowActions,
  STATUS_LABEL,
  type NoteSnapshot,
} from "./schedule-workflow";

const pushed: NoteSnapshot = {
  id: "note_pushed",
  status: "active",
  ehrDocumentRef: "DocumentReference/abc-123",
  ehrPushedAt: "2026-05-17T15:00:00Z",
  ehrError: null,
};

const draft: NoteSnapshot = {
  id: "note_draft",
  status: "active",
  ehrDocumentRef: null,
  ehrPushedAt: null,
  ehrError: null,
};

const failed: NoteSnapshot = {
  id: "note_failed",
  status: "active",
  ehrDocumentRef: null,
  ehrPushedAt: null,
  ehrError: "FHIR validation failed",
};

const withdrawn: NoteSnapshot = {
  id: "note_eie",
  status: "entered-in-error",
  ehrDocumentRef: null,
  ehrPushedAt: null,
  ehrError: null,
};

describe("deriveWorkflowStatus", () => {
  describe("core product rule: Completed requires a successful EHR push", () => {
    it("Completed when ehrDocumentRef + ehrPushedAt set and no ehrError", () => {
      expect(deriveWorkflowStatus({ fhirStatus: "booked" }, pushed)).toBe(
        "completed",
      );
    });

    it("NOT Completed when note exists but never pushed", () => {
      expect(deriveWorkflowStatus({ fhirStatus: "booked" }, draft)).toBe(
        "in_progress",
      );
    });

    it("NOT Completed when only ehrPushedAt set without ehrDocumentRef", () => {
      // Defensive: a half-written push state must not register as
      // completed. Both fields are required by the product rule.
      const halfPushed: NoteSnapshot = {
        ...draft,
        ehrPushedAt: "2026-05-17T15:00:00Z",
        ehrDocumentRef: null,
      };
      expect(deriveWorkflowStatus({ fhirStatus: "booked" }, halfPushed)).toBe(
        "in_progress",
      );
    });

    it("NOT Completed when only ehrDocumentRef set without ehrPushedAt", () => {
      const halfPushed: NoteSnapshot = {
        ...draft,
        ehrDocumentRef: "DocumentReference/x",
        ehrPushedAt: null,
      };
      expect(deriveWorkflowStatus({ fhirStatus: "booked" }, halfPushed)).toBe(
        "in_progress",
      );
    });

    it("NOT Completed when Athena says 'fulfilled' but no note", () => {
      // Spec is explicit: Athena marking the appointment fulfilled is
      // not sufficient — the HaloNote-authored note must be pushed.
      expect(deriveWorkflowStatus({ fhirStatus: "fulfilled" }, null)).toBe(
        "unknown",
      );
    });

    it("NOT Completed when only autosave (no EHR push) has occurred", () => {
      // The autosaved note has body/updatedAt but no EHR fields — must
      // remain In progress until pushed.
      expect(deriveWorkflowStatus({ fhirStatus: "arrived" }, draft)).toBe(
        "in_progress",
      );
    });
  });

  describe("Failed sync", () => {
    it("Failed sync when ehrError is set even if ehrPushedAt happens to be present", () => {
      const partiallyFailed: NoteSnapshot = {
        ...pushed,
        ehrError: "upstream 502",
      };
      expect(
        deriveWorkflowStatus({ fhirStatus: "arrived" }, partiallyFailed),
      ).toBe("failed_sync");
    });

    it("Failed sync regardless of FHIR appointment state (except terminal)", () => {
      expect(deriveWorkflowStatus({ fhirStatus: "booked" }, failed)).toBe(
        "failed_sync",
      );
      expect(deriveWorkflowStatus({ fhirStatus: "arrived" }, failed)).toBe(
        "failed_sync",
      );
    });
  });

  describe("FHIR-state precedence", () => {
    it("Cancelled overrides any note state", () => {
      expect(deriveWorkflowStatus({ fhirStatus: "cancelled" }, pushed)).toBe(
        "cancelled",
      );
      expect(deriveWorkflowStatus({ fhirStatus: "cancelled" }, failed)).toBe(
        "cancelled",
      );
    });

    it("No-show overrides any note state", () => {
      expect(deriveWorkflowStatus({ fhirStatus: "noshow" }, pushed)).toBe(
        "no_show",
      );
      expect(deriveWorkflowStatus({ fhirStatus: "no-show" }, pushed)).toBe(
        "no_show",
      );
    });

    it("Checked in when Athena reports arrived/checked-in and there is no note", () => {
      expect(deriveWorkflowStatus({ fhirStatus: "arrived" }, null)).toBe(
        "checked_in",
      );
      expect(deriveWorkflowStatus({ fhirStatus: "checked-in" }, null)).toBe(
        "checked_in",
      );
    });

    it("Pending when booked/proposed and no note", () => {
      for (const s of ["booked", "proposed", "pending", "waitlist"]) {
        expect(deriveWorkflowStatus({ fhirStatus: s }, null)).toBe("pending");
      }
    });
  });

  describe("entered-in-error notes are treated as absent", () => {
    it("a withdrawn note does not block Pending", () => {
      expect(deriveWorkflowStatus({ fhirStatus: "booked" }, withdrawn)).toBe(
        "pending",
      );
    });

    it("a withdrawn note does not promote to Completed even with the EHR fields populated", () => {
      const withdrawnButPushed: NoteSnapshot = {
        ...pushed,
        status: "entered-in-error",
      };
      expect(
        deriveWorkflowStatus({ fhirStatus: "booked" }, withdrawnButPushed),
      ).toBe("pending");
    });
  });

  it("Unknown for an unrecognized appointment status with no note", () => {
    expect(
      deriveWorkflowStatus({ fhirStatus: "some-weird-status" }, null),
    ).toBe("unknown");
  });

  it("case-insensitive on the FHIR status", () => {
    expect(deriveWorkflowStatus({ fhirStatus: "ARRIVED" }, null)).toBe(
      "checked_in",
    );
    expect(deriveWorkflowStatus({ fhirStatus: "Cancelled" }, pushed)).toBe(
      "cancelled",
    );
  });
});

describe("workflowActions", () => {
  it("offers Start note when no note exists for a pending/checked-in appointment", () => {
    expect(workflowActions("pending", false)).toEqual(["start_note"]);
    expect(workflowActions("checked_in", false)).toEqual(["start_note"]);
  });

  it("offers Continue + Send when a note is in progress", () => {
    expect(workflowActions("in_progress", true)).toEqual([
      "continue_note",
      "send_to_ehr",
    ]);
  });

  it("offers Retry first when a push has failed", () => {
    expect(workflowActions("failed_sync", true)).toEqual([
      "retry_send",
      "continue_note",
    ]);
  });

  it("offers View only when completed", () => {
    expect(workflowActions("completed", true)).toEqual(["view_note"]);
  });

  it("offers no actions on cancelled / no-show", () => {
    expect(workflowActions("cancelled", false)).toEqual(["none"]);
    expect(workflowActions("no_show", false)).toEqual(["none"]);
  });
});

describe("STATUS_LABEL", () => {
  it("provides a non-empty user-facing label for every status", () => {
    for (const k of [
      "pending",
      "checked_in",
      "in_progress",
      "completed",
      "failed_sync",
      "cancelled",
      "no_show",
      "unknown",
    ] as const) {
      expect(STATUS_LABEL[k].length).toBeGreaterThan(0);
    }
  });
});
