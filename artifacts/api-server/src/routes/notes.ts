import { Router, type IRouter } from "express";
import { and, desc, eq, lt } from "drizzle-orm";
import { CreateNoteBody, UpdateNoteBody } from "@workspace/api-zod";
import { getDb, notesTable, usersTable } from "@workspace/db";
import { EhrPushError, pushNoteToEhr } from "../lib/ehr-push";
import { findPatient } from "../lib/patients";

const router: IRouter = Router();

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

// Drizzle's $inferSelect-derived row type expanded with the embedded author.
// We construct this shape explicitly in every handler so the wire response
// matches the OpenAPI `Note` schema (which has `author: NoteAuthor | null`).
const noteSelect = {
  id: notesTable.id,
  patientId: notesTable.patientId,
  body: notesTable.body,
  createdAt: notesTable.createdAt,
  updatedAt: notesTable.updatedAt,
  authorId: notesTable.authorId,
  ehrProvider: notesTable.ehrProvider,
  ehrDocumentRef: notesTable.ehrDocumentRef,
  ehrPushedAt: notesTable.ehrPushedAt,
  ehrError: notesTable.ehrError,
  authorDisplayName: usersTable.displayName,
} as const;

type NoteRow = {
  id: string;
  patientId: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
  authorId: string | null;
  ehrProvider: string | null;
  ehrDocumentRef: string | null;
  ehrPushedAt: Date | null;
  ehrError: string | null;
  authorDisplayName: string | null;
};

function serializeNote(row: NoteRow) {
  return {
    id: row.id,
    patientId: row.patientId,
    body: row.body,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    author:
      row.authorId && row.authorDisplayName
        ? { id: row.authorId, displayName: row.authorDisplayName }
        : null,
    ehrProvider: row.ehrProvider,
    ehrDocumentRef: row.ehrDocumentRef,
    ehrPushedAt: row.ehrPushedAt,
    ehrError: row.ehrError,
  };
}

router.get("/notes/:id", async (req, res) => {
  const rows = await getDb()
    .select(noteSelect)
    .from(notesTable)
    .leftJoin(usersTable, eq(notesTable.authorId, usersTable.id))
    .where(eq(notesTable.id, req.params.id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    res.status(404).json({ error: "note_not_found" });
    return;
  }
  res.json(serializeNote(row));
});

router.get("/notes", async (req, res) => {
  const patientId =
    typeof req.query["patientId"] === "string"
      ? req.query["patientId"].trim() || undefined
      : undefined;
  const before = parseIsoDate(req.query["before"]);
  const limit = clampLimit(req.query["limit"]);

  const conditions = [];
  if (patientId) conditions.push(eq(notesTable.patientId, patientId));
  if (before) conditions.push(lt(notesTable.createdAt, before));

  const where =
    conditions.length === 0
      ? undefined
      : conditions.length === 1
        ? conditions[0]
        : and(...conditions);

  // Fetch limit+1 to know if there's another page without a separate
  // count query.
  const db = getDb();
  const builder = db
    .select(noteSelect)
    .from(notesTable)
    .leftJoin(usersTable, eq(notesTable.authorId, usersTable.id));

  const rows = where
    ? await builder
        .where(where)
        .orderBy(desc(notesTable.createdAt))
        .limit(limit + 1)
    : await builder.orderBy(desc(notesTable.createdAt)).limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const tail = page[page.length - 1];
  const nextCursor = hasMore && tail ? tail.createdAt.toISOString() : null;

  res.json({ data: page.map(serializeNote), nextCursor });
});

router.post("/notes", async (req, res) => {
  const parsed = CreateNoteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_request",
      issues: parsed.error.issues,
    });
    return;
  }

  const author = req.user;
  if (!author) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  try {
    const inserted = await getDb()
      .insert(notesTable)
      .values({
        patientId: parsed.data.patientId,
        body: parsed.data.body,
        authorId: author.id,
      })
      .returning();
    const note = inserted[0];
    if (!note) {
      throw new Error("Insert returned no row");
    }
    res.status(201).json(
      serializeNote({
        ...note,
        authorDisplayName: author.displayName,
      }),
    );
  } catch (err) {
    req.log.error({ err }, "Failed to insert note");
    res.status(500).json({ error: "persistence_failed" });
  }
});

router.patch("/notes/:id", async (req, res) => {
  const parsed = UpdateNoteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_request",
      issues: parsed.error.issues,
    });
    return;
  }

  const noteId = req.params.id;
  const db = getDb();

  try {
    const updated = await db
      .update(notesTable)
      .set({
        body: parsed.data.body,
        updatedAt: new Date(),
      })
      .where(eq(notesTable.id, noteId))
      .returning();
    const note = updated[0];
    if (!note) {
      res.status(404).json({ error: "note_not_found" });
      return;
    }

    // Re-read with the author join so the response includes author.
    const rows = await db
      .select(noteSelect)
      .from(notesTable)
      .leftJoin(usersTable, eq(notesTable.authorId, usersTable.id))
      .where(eq(notesTable.id, noteId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new Error("Note vanished between UPDATE and SELECT");
    }
    res.json(serializeNote(row));
  } catch (err) {
    req.log.error({ err, noteId }, "Failed to update note");
    res.status(500).json({ error: "persistence_failed" });
  }
});

router.post("/notes/:id/send-to-ehr", async (req, res) => {
  const noteId = req.params.id;
  const db = getDb();

  const rows = await db
    .select()
    .from(notesTable)
    .where(eq(notesTable.id, noteId))
    .limit(1);
  const note = rows[0];
  if (!note) {
    res.status(404).json({ error: "note_not_found" });
    return;
  }

  const patient = await findPatient(note.patientId);
  if (!patient) {
    res.status(404).json({ error: "patient_not_found" });
    return;
  }

  try {
    const outcome = await pushNoteToEhr({
      note: { id: note.id, body: note.body },
      patient,
    });

    await db
      .update(notesTable)
      .set({
        ehrProvider: outcome.provider,
        ehrDocumentRef: outcome.ehrDocumentRef,
        ehrPushedAt: outcome.pushedAt,
        ehrError: null,
      })
      .where(eq(notesTable.id, noteId));

    res.status(200).json({
      provider: outcome.provider,
      ehrDocumentRef: outcome.ehrDocumentRef,
      pushedAt: outcome.pushedAt,
      mock: outcome.mock,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.error({ err, noteId }, "EHR push failed");

    await db
      .update(notesTable)
      .set({ ehrError: message })
      .where(eq(notesTable.id, noteId))
      .catch(() => {
        // best-effort error capture; ignore secondary failure
      });

    if (err instanceof EhrPushError) {
      res.status(err.status).json({ error: "ehr_push_failed", message });
      return;
    }
    res.status(500).json({ error: "ehr_push_failed", message });
  }
});

function parseIsoDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function clampLimit(value: unknown): number {
  const raw =
    typeof value === "string"
      ? Number(value)
      : typeof value === "number"
        ? value
        : NaN;
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.floor(raw), MAX_PAGE_LIMIT);
}

export default router;
