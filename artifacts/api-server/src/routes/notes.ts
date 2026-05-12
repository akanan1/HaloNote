import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { CreateNoteBody } from "@workspace/api-zod";
import { getDb, notesTable, usersTable } from "@workspace/db";
import { EhrPushError, pushNoteToEhr } from "../lib/ehr-push";
import { findPatient } from "../lib/patients";

const router: IRouter = Router();

// Drizzle's $inferSelect-derived row type expanded with the embedded author.
// We construct this shape explicitly in every handler so the wire response
// matches the OpenAPI `Note` schema (which has `author: NoteAuthor | null`).
const noteSelect = {
  id: notesTable.id,
  patientId: notesTable.patientId,
  body: notesTable.body,
  createdAt: notesTable.createdAt,
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
      ? req.query["patientId"].trim()
      : undefined;

  const db = getDb();
  const base = db
    .select(noteSelect)
    .from(notesTable)
    .leftJoin(usersTable, eq(notesTable.authorId, usersTable.id));

  const rows = patientId
    ? await base
        .where(eq(notesTable.patientId, patientId))
        .orderBy(desc(notesTable.createdAt))
    : await base.orderBy(desc(notesTable.createdAt));

  res.json({ data: rows.map(serializeNote) });
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

export default router;
