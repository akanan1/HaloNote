import { describe, expect, it } from "vitest";
import {
  LOCKED_STATUSES,
  NOTE_STATUSES,
  serializeNote,
  type NoteRow,
  type NoteStatus,
} from "./notes";

// Pure-data tests for the service surface that doesn't need a DB. The
// query helpers (findNoteById / listNotes) are integration-tested via
// the routes that consume them (see routes/notes.integration.test.ts).

const baseRow: NoteRow = {
  id: "note_1",
  patientId: "pt_1",
  encounterId: "enc_1",
  body: "SOAP body",
  createdAt: new Date("2026-06-18T10:00:00Z"),
  updatedAt: new Date("2026-06-18T10:05:00Z"),
  authorId: null,
  status: "draft",
  approvedAt: null,
  approvedByUserId: null,
  signedNoteHash: null,
  replacesNoteId: null,
  ehrProvider: null,
  ehrDocumentRef: null,
  ehrPushedAt: null,
  ehrError: null,
  autoPushedWithoutReview: false,
  authorDisplayName: null,
};

describe("serializeNote", () => {
  it("emits a null author when the note has no authorId", () => {
    const out = serializeNote(baseRow);
    expect(out.author).toBeNull();
  });

  it("emits {id, displayName} when both authorId and authorDisplayName are present", () => {
    const out = serializeNote({
      ...baseRow,
      authorId: "user_1",
      authorDisplayName: "Dr Avery",
    });
    expect(out.author).toEqual({ id: "user_1", displayName: "Dr Avery" });
  });

  it("emits null author when authorId exists but the join returned no displayName", () => {
    // E.g. a soft-deleted user whose row still has the FK; the wire
    // shape must collapse to null so the UI doesn't render a half-author.
    const out = serializeNote({
      ...baseRow,
      authorId: "user_ghost",
      authorDisplayName: null,
    });
    expect(out.author).toBeNull();
  });

  it("preserves signedNoteHash on the wire (frontend renders tamper-evident UI)", () => {
    const out = serializeNote({
      ...baseRow,
      status: "approved",
      signedNoteHash: "deadbeef",
    });
    expect(out.signedNoteHash).toBe("deadbeef");
  });

  it("forwards EHR push fields verbatim", () => {
    const out = serializeNote({
      ...baseRow,
      ehrProvider: "athenahealth",
      ehrDocumentRef: "DocumentReference/123",
      ehrPushedAt: new Date("2026-06-18T11:00:00Z"),
      ehrError: null,
    });
    expect(out.ehrProvider).toBe("athenahealth");
    expect(out.ehrDocumentRef).toBe("DocumentReference/123");
    expect(out.ehrError).toBeNull();
  });
});

describe("LOCKED_STATUSES", () => {
  it("covers exactly the statuses that block direct body edits", () => {
    // Mirror of the FHIR-aligned state machine: once a note is signed
    // (approved), exported, or withdrawn (entered-in-error), the only
    // legal mutation is via the replaces chain. `draft` is editable.
    // `active` is the legacy bucket — still editable per migration 0023.
    const editable: NoteStatus[] = ["draft", "active"];
    const locked = NOTE_STATUSES.filter((s) => !editable.includes(s));
    expect([...LOCKED_STATUSES].sort()).toEqual(locked.sort());
  });
});

describe("NOTE_STATUSES", () => {
  it("includes the legacy `active` value so stale clients don't error", () => {
    // Migration 0023 backfilled active → approved, but the wire union
    // still has to accept "active" for one release so older provider-app
    // builds posting that value against a current server keep working.
    expect(NOTE_STATUSES).toContain("active");
  });

  it("covers the full FHIR-style lifecycle including entered-in-error", () => {
    expect([...NOTE_STATUSES].sort()).toEqual(
      [
        "active",
        "approved",
        "draft",
        "entered-in-error",
        "exported",
      ].sort(),
    );
  });
});
