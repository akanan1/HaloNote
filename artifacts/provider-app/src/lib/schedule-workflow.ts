// Workflow status derivation for the Today / Schedule view.
//
// Combines the upstream FHIR Appointment.status with HaloNote's
// per-note EHR-push state into a single coarser status the clinician
// can act on.
//
// Core product rule: an appointment is "Completed" ONLY when a
// matching note has been successfully pushed to the EHR
// (ehrDocumentRef + ehrPushedAt set, no active ehrError).
// "Completed" does NOT mean:
//   - the appointment time has passed
//   - the note merely exists locally
//   - the note has been autosaved
//   - Athena reports Appointment.status = "fulfilled" with no note
//
// This file contains the pure mapping. The Today page wires data
// into it; tests pin the rules.

export type WorkflowStatus =
  | "pending" // booked, no note
  | "checked_in" // Athena arrived/checked-in, no note
  | "in_progress" // note exists, not pushed (also covers "ready to send"
  //                — there is no separate "finalized" flag in the schema)
  | "completed" // note pushed successfully
  | "failed_sync" // ehrError present on the matched note
  | "cancelled" // Athena cancelled
  | "no_show" // Athena no-show
  | "unknown"; // appointment status we don't recognize + no note

// Matches the generated NoteStatus from @workspace/api-client-react.
// Inlined here (rather than imported) so this module stays usable from
// non-react test contexts. Keep in lockstep with openapi.yaml's
// Note.status enum.
export type NoteSnapshotStatus =
  | "draft"
  | "approved"
  | "exported"
  | "entered-in-error"
  | "active";

export interface NoteSnapshot {
  id: string;
  // entered-in-error is treated as no note for the purposes of
  // workflow status (the row stays for audit but should never block
  // "Pending → In progress" for a fresh visit). draft / approved /
  // exported all map to in_progress / completed depending on whether
  // EHR push has landed.
  status: NoteSnapshotStatus;
  ehrDocumentRef: string | null;
  ehrPushedAt: Date | string | null;
  ehrError: string | null;
}

export interface AppointmentInput {
  // FHIR Appointment.status: typically one of
  // booked / pending / proposed / waitlist / arrived / checked-in /
  // fulfilled / cancelled / noshow / entered-in-error.
  fhirStatus: string;
}

export function deriveWorkflowStatus(
  appt: AppointmentInput,
  rawNote: NoteSnapshot | null,
): WorkflowStatus {
  const fhir = appt.fhirStatus.toLowerCase();

  // Terminal Athena states win — a cancelled visit doesn't become
  // "Completed" because someone wrote a note about it.
  if (fhir === "cancelled") return "cancelled";
  if (fhir === "noshow" || fhir === "no-show") return "no_show";

  // entered-in-error notes are withdrawn — don't let them gate the
  // status. Treat as if no note exists.
  const note = rawNote && rawNote.status !== "entered-in-error" ? rawNote : null;

  if (note) {
    // Product rule: Completed strictly requires a successful push.
    if (note.ehrError) return "failed_sync";
    if (note.ehrDocumentRef && note.ehrPushedAt) return "completed";
    return "in_progress";
  }

  // No (active) matching note — defer to the appointment's own state.
  if (fhir === "arrived" || fhir === "checked-in" || fhir === "checked_in") {
    return "checked_in";
  }
  if (
    fhir === "booked" ||
    fhir === "proposed" ||
    fhir === "pending" ||
    fhir === "waitlist"
  ) {
    return "pending";
  }

  // Includes Athena "fulfilled" with no note we know about — the
  // clinician needs to investigate (did someone else document it? was
  // the note attached to a different appointment?). Don't silently
  // claim Completed.
  return "unknown";
}

// Card-level action vocabulary. The Today page maps each status to one
// or more of these. Defined here so tests + the page agree.
export type WorkflowAction =
  | "start_note"
  | "continue_note"
  | "send_to_ehr"
  | "retry_send"
  | "view_note"
  | "none";

export function workflowActions(
  status: WorkflowStatus,
  hasNote: boolean,
): readonly WorkflowAction[] {
  switch (status) {
    case "pending":
    case "checked_in":
    case "unknown":
      return hasNote ? ["continue_note", "send_to_ehr"] : ["start_note"];
    case "in_progress":
      return ["continue_note", "send_to_ehr"];
    case "failed_sync":
      return ["retry_send", "continue_note"];
    case "completed":
      return ["view_note"];
    case "cancelled":
    case "no_show":
      return ["none"];
  }
}

// UI labels + Tailwind tone classes. Living here so the test suite can
// snapshot the visible vocabulary in one place.
export const STATUS_LABEL: Record<WorkflowStatus, string> = {
  pending: "Pending",
  checked_in: "Checked in",
  in_progress: "In progress",
  completed: "Completed",
  failed_sync: "Failed sync",
  cancelled: "Cancelled",
  no_show: "No-show",
  unknown: "Unknown",
};

export const STATUS_TONE: Record<WorkflowStatus, string> = {
  pending: "bg-sky-50 text-sky-800 ring-sky-200",
  checked_in: "bg-amber-50 text-amber-800 ring-amber-200",
  in_progress: "bg-violet-50 text-violet-800 ring-violet-200",
  completed: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  failed_sync: "bg-red-50 text-red-800 ring-red-200",
  cancelled:
    "bg-(--color-muted) text-(--color-muted-foreground) ring-(--color-border)",
  no_show:
    "bg-(--color-muted) text-(--color-muted-foreground) ring-(--color-border)",
  unknown:
    "bg-(--color-muted) text-(--color-muted-foreground) ring-(--color-border)",
};
