// NotesService — read-side service for the notes resource. Pure functions
// over the db; no Express types, no req/res. The first concrete instance
// of the spine-extraction pattern: routes/* parse + serialize, services/*
// own the org-scoped query and any business invariants.
//
// Scope of this module:
//   - findNoteById(id, orgId)       — single read with author join
//   - listNotes(orgId, filter)      — cursor-paginated list with optional
//                                     patient / status / author filters
//   - serializeNote(row)            — wire shape; matches OpenAPI `Note`
//
// Out of scope (still in routes/notes.ts for now):
//   - POST / PATCH / DELETE / approve / refine / send-to-ehr
//     These will migrate in follow-up commits using the same shape.

import { createHash } from "node:crypto";
import { and, desc, eq, lt } from "drizzle-orm";
import {
  encountersTable,
  getDb,
  notesTable,
  patientsTable,
  usersTable,
} from "@workspace/db";

// Note status union, mirrored from the schema. Re-declared here as a
// runtime tuple so callers can validate query input against it without
// reaching into the schema's TypeScript-only type.
export const NOTE_STATUSES = [
  "draft",
  "approved",
  "exported",
  "entered-in-error",
  "active",
] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

const noteSelect = {
  id: notesTable.id,
  patientId: notesTable.patientId,
  encounterId: notesTable.encounterId,
  body: notesTable.body,
  createdAt: notesTable.createdAt,
  updatedAt: notesTable.updatedAt,
  authorId: notesTable.authorId,
  status: notesTable.status,
  approvedAt: notesTable.approvedAt,
  approvedByUserId: notesTable.approvedByUserId,
  signedNoteHash: notesTable.signedNoteHash,
  replacesNoteId: notesTable.replacesNoteId,
  ehrProvider: notesTable.ehrProvider,
  ehrDocumentRef: notesTable.ehrDocumentRef,
  ehrPushedAt: notesTable.ehrPushedAt,
  ehrError: notesTable.ehrError,
  autoPushedWithoutReview: notesTable.autoPushedWithoutReview,
  authorDisplayName: usersTable.displayName,
} as const;

export interface NoteRow {
  id: string;
  patientId: string;
  encounterId: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
  authorId: string | null;
  status: NoteStatus;
  approvedAt: Date | null;
  approvedByUserId: string | null;
  signedNoteHash: string | null;
  replacesNoteId: string | null;
  ehrProvider: string | null;
  ehrDocumentRef: string | null;
  ehrPushedAt: Date | null;
  ehrError: string | null;
  autoPushedWithoutReview: boolean;
  authorDisplayName: string | null;
}

export function serializeNote(row: NoteRow) {
  return {
    id: row.id,
    patientId: row.patientId,
    encounterId: row.encounterId,
    body: row.body,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    author:
      row.authorId && row.authorDisplayName
        ? { id: row.authorId, displayName: row.authorDisplayName }
        : null,
    status: row.status,
    approvedAt: row.approvedAt,
    approvedByUserId: row.approvedByUserId,
    // signedNoteHash is intentionally exposed: the frontend renders a
    // tamper-evident indicator and downstream auditors can verify a
    // note matches the body they see by recomputing sha256.
    signedNoteHash: row.signedNoteHash,
    replacesNoteId: row.replacesNoteId,
    ehrProvider: row.ehrProvider,
    ehrDocumentRef: row.ehrDocumentRef,
    ehrPushedAt: row.ehrPushedAt,
    ehrError: row.ehrError,
    autoPushedWithoutReview: row.autoPushedWithoutReview,
  };
}

// Single read, always org-scoped. Returns null when the row doesn't
// exist *in the caller's org* — callers must NOT distinguish "not in
// my org" from "doesn't exist at all" to the client, or they leak the
// existence of cross-tenant rows.
export async function findNoteById(
  id: string,
  orgId: string,
): Promise<NoteRow | null> {
  const rows = await getDb()
    .select(noteSelect)
    .from(notesTable)
    .leftJoin(usersTable, eq(notesTable.authorId, usersTable.id))
    .where(and(eq(notesTable.id, id), eq(notesTable.organizationId, orgId)))
    .limit(1);
  return rows[0] ?? null;
}

export interface ListNotesFilter {
  patientId?: string;
  before?: Date;
  status?: NoteStatus;
  authorId?: string;
  // Caller is responsible for clamping (see http/pagination#clampLimit).
  // The service trusts whatever number it gets — that's a deliberate
  // boundary: validation lives at the HTTP edge, not here.
  limit: number;
}

export interface ListNotesResult {
  rows: NoteRow[];
  // ISO 8601 timestamp of the oldest row in this page, or null when
  // there is no next page. Pass back as `?before=<cursor>` to paginate.
  nextCursor: string | null;
}

// Statuses that lock the note body from further direct edits. Once a
// note is approved/exported/withdrawn, the only way to change the body
// is to create a successor via the FHIR replaces chain.
export const LOCKED_STATUSES: readonly NoteStatus[] = [
  "approved",
  "exported",
  "entered-in-error",
];

// Input shape for createNote. Mirrors the validated CreateNoteBody from
// api-zod (kept narrow on purpose so the service is callable from non-
// HTTP entry points — CLI, jobs, future RPC — without dragging Express
// types in).
export interface CreateNoteInput {
  patientId: string;
  body: string;
  encounterId?: string | null;
  replacesNoteId?: string | null;
}

// Author identity threaded through the route layer. Display name lives
// on the row's join surface; we mirror it onto the response without a
// second round-trip after the insert.
export interface NoteAuthor {
  id: string;
  displayName: string;
}

// Discriminated result for createNote. Each error case maps to a stable
// HTTP envelope at the route — see routes/notes.ts. Putting all the
// failure modes in the type makes it impossible to forget one when the
// caller switches on `kind`.
export type CreateNoteResult =
  | { kind: "ok"; row: NoteRow }
  | { kind: "patient_not_found" }
  | { kind: "predecessor_not_found" }
  | { kind: "predecessor_entered_in_error" }
  | { kind: "predecessor_patient_mismatch" }
  | { kind: "encounter_not_found" }
  | { kind: "encounter_patient_mismatch" };

// Creates a note after enforcing the cross-row preconditions: patient
// belongs to the caller's org, optional predecessor is in the same org +
// same patient + not withdrawn, optional encounter is in the same org +
// same patient. 404 (not 403) is the right surface for cross-org rows —
// revealing "exists but in another tenant" is itself a leak.
export async function createNote(
  orgId: string,
  author: NoteAuthor,
  input: CreateNoteInput,
): Promise<CreateNoteResult> {
  const db = getDb();

  const [patient] = await db
    .select({
      id: patientsTable.id,
      organizationId: patientsTable.organizationId,
    })
    .from(patientsTable)
    .where(eq(patientsTable.id, input.patientId))
    .limit(1);
  if (!patient || patient.organizationId !== orgId) {
    return { kind: "patient_not_found" };
  }

  if (input.replacesNoteId) {
    const [predecessor] = await db
      .select({
        id: notesTable.id,
        status: notesTable.status,
        patientId: notesTable.patientId,
        organizationId: notesTable.organizationId,
      })
      .from(notesTable)
      .where(eq(notesTable.id, input.replacesNoteId))
      .limit(1);
    if (!predecessor || predecessor.organizationId !== orgId) {
      return { kind: "predecessor_not_found" };
    }
    if (predecessor.status === "entered-in-error") {
      return { kind: "predecessor_entered_in_error" };
    }
    if (predecessor.patientId !== input.patientId) {
      return { kind: "predecessor_patient_mismatch" };
    }
  }

  const encounterId = input.encounterId ?? null;
  if (encounterId) {
    const [enc] = await db
      .select({
        id: encountersTable.id,
        organizationId: encountersTable.organizationId,
        patientId: encountersTable.patientId,
      })
      .from(encountersTable)
      .where(eq(encountersTable.id, encounterId))
      .limit(1);
    if (!enc || enc.organizationId !== orgId) {
      return { kind: "encounter_not_found" };
    }
    if (enc.patientId !== input.patientId) {
      return { kind: "encounter_patient_mismatch" };
    }
  }

  const inserted = await db
    .insert(notesTable)
    .values({
      organizationId: orgId,
      patientId: input.patientId,
      body: input.body,
      authorId: author.id,
      ...(encounterId ? { encounterId } : {}),
      ...(input.replacesNoteId
        ? { replacesNoteId: input.replacesNoteId }
        : {}),
    })
    .returning();
  const note = inserted[0];
  if (!note) {
    throw new Error("Insert returned no row");
  }
  // The row's author display name comes from the caller — we already
  // have it from the auth layer; skipping the join keeps this to a
  // single DB write.
  return {
    kind: "ok",
    row: { ...note, authorDisplayName: author.displayName },
  };
}

// Discriminated result for body updates. Lets the HTTP layer translate
// to the right status code (404 vs 409 vs 200) without leaking service
// internals into a thrown-error contract.
export type UpdateNoteBodyResult =
  | { kind: "not_found" }
  | { kind: "locked"; status: NoteStatus }
  | { kind: "ok"; row: NoteRow };

// Edits the body of a draft note. Enforces the state machine: only
// `draft` notes accept body edits; approved/exported/withdrawn notes
// require a replaces-chain amendment instead. The pre-fetch (as opposed
// to a WHERE clause on the UPDATE) lets us return the *current* locked
// status to the caller so the UI can route the provider to the right
// amendment flow.
export async function updateNoteBody(
  id: string,
  orgId: string,
  body: string,
): Promise<UpdateNoteBodyResult> {
  const db = getDb();
  const [existing] = await db
    .select({
      id: notesTable.id,
      status: notesTable.status,
    })
    .from(notesTable)
    .where(and(eq(notesTable.id, id), eq(notesTable.organizationId, orgId)))
    .limit(1);
  if (!existing) return { kind: "not_found" };
  if (LOCKED_STATUSES.includes(existing.status)) {
    return { kind: "locked", status: existing.status };
  }

  await db
    .update(notesTable)
    .set({ body, updatedAt: new Date() })
    .where(and(eq(notesTable.id, id), eq(notesTable.organizationId, orgId)));

  // Re-read with the author join so the response shape matches the rest
  // of the read surface.
  const row = await findNoteById(id, orgId);
  if (!row) {
    // Race: the row was deleted between our UPDATE and the re-read.
    // Surface as not_found rather than synthesising a partial row.
    return { kind: "not_found" };
  }
  return { kind: "ok", row };
}

// Hex SHA-256 of a string. Used as the tamper-evident signed-note
// hash at approval time; any later change to the body without going
// through the FHIR replaces chain would mismatch on re-approval.
function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// Result of approveNote. The route layer maps the non-ok kinds to HTTP
// status codes; `approved` (fresh transition) is the signal the route
// uses to decide whether to fire optional auto-push side effects.
export type ApproveNoteResult =
  | { kind: "not_found" }
  | { kind: "entered_in_error" }
  | { kind: "already_exported" }
  | { kind: "signed_hash_mismatch" }
  | { kind: "approved"; row: NoteRow }
  | { kind: "idempotent"; row: NoteRow };

// Transitions a draft note to `approved`, stamping approved_at,
// approved_by_user_id, and signed_note_hash. Idempotent: re-approving
// an already-approved note with the same body hash is a no-op (returns
// `idempotent`); a hash mismatch surfaces tampering. Approving an
// exported or withdrawn note is refused — those terminal states need a
// replaces-chain amendment.
//
// Side-effects (auto-push to EHR) belong to the caller: the service
// stays pure-DB so it's reusable from a CLI / job / batch path that
// shouldn't trigger network writes.
export async function approveNote(
  id: string,
  orgId: string,
  approverId: string,
): Promise<ApproveNoteResult> {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(notesTable)
    .where(and(eq(notesTable.id, id), eq(notesTable.organizationId, orgId)))
    .limit(1);
  if (!existing) return { kind: "not_found" };
  if (existing.status === "entered-in-error") {
    return { kind: "entered_in_error" };
  }
  if (existing.status === "exported") return { kind: "already_exported" };

  const hash = sha256Hex(existing.body);

  if (existing.status === "approved") {
    // Idempotent re-approval is allowed iff the body hasn't drifted.
    if (existing.signedNoteHash && existing.signedNoteHash !== hash) {
      return { kind: "signed_hash_mismatch" };
    }
    const row = await findNoteById(id, orgId);
    if (!row) return { kind: "not_found" };
    return { kind: "idempotent", row };
  }

  const now = new Date();
  await db
    .update(notesTable)
    .set({
      status: "approved",
      approvedAt: now,
      approvedByUserId: approverId,
      signedNoteHash: hash,
      updatedAt: now,
    })
    .where(and(eq(notesTable.id, id), eq(notesTable.organizationId, orgId)));

  const row = await findNoteById(id, orgId);
  if (!row) return { kind: "not_found" };
  return { kind: "approved", row };
}

// Soft-deletes the note by transitioning to `entered-in-error`. The
// row stays in the database for audit traceability + amendment-chain
// integrity. Returns true when a row was updated, false when no row
// matched (caller should 404).
//
// Idempotent: re-deleting an already-entered-in-error note still
// matches the WHERE and returns true. That's intentional — the client
// can replay safely on a flaky network without surfacing spurious 404s.
export async function softDeleteNote(
  id: string,
  orgId: string,
): Promise<boolean> {
  const result = await getDb()
    .update(notesTable)
    .set({ status: "entered-in-error", updatedAt: new Date() })
    .where(and(eq(notesTable.id, id), eq(notesTable.organizationId, orgId)))
    .returning({ id: notesTable.id });
  return result.length > 0;
}

export async function listNotes(
  orgId: string,
  filter: ListNotesFilter,
): Promise<ListNotesResult> {
  // Tenant scope is always on. Additional filters narrow within the org.
  const conditions = [eq(notesTable.organizationId, orgId)];
  if (filter.patientId) conditions.push(eq(notesTable.patientId, filter.patientId));
  if (filter.before) conditions.push(lt(notesTable.createdAt, filter.before));
  if (filter.status) conditions.push(eq(notesTable.status, filter.status));
  if (filter.authorId) conditions.push(eq(notesTable.authorId, filter.authorId));

  // Fetch limit+1 so we know whether another page exists without a
  // separate count query.
  const rows = await getDb()
    .select(noteSelect)
    .from(notesTable)
    .leftJoin(usersTable, eq(notesTable.authorId, usersTable.id))
    .where(and(...conditions))
    .orderBy(desc(notesTable.createdAt))
    .limit(filter.limit + 1);

  const hasMore = rows.length > filter.limit;
  const page = hasMore ? rows.slice(0, filter.limit) : rows;
  const tail = page[page.length - 1];
  const nextCursor = hasMore && tail ? tail.createdAt.toISOString() : null;
  return { rows: page, nextCursor };
}
