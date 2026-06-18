import { Router, type IRouter } from "express";
import { and, desc, eq, gte, lte, lt, or, type SQL } from "drizzle-orm";
import { getDb, notesTable, usersTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/require-admin";
import { getActiveOrgId } from "../lib/active-org";

const router: IRouter = Router();

// Every route in this file is admin-only. The parent MUST mount this
// sub-router under a path prefix ("/admin/auto-pushed-notes") so the
// path-agnostic `router.use(requireAdmin)` only fires for requests
// under that prefix — otherwise it 403s every unrelated request that
// reaches this router.
router.use(requireAdmin);

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

const autoPushedSelect = {
  noteId: notesTable.id,
  patientId: notesTable.patientId,
  authorId: notesTable.authorId,
  createdAt: notesTable.createdAt,
  ehrPushedAt: notesTable.ehrPushedAt,
  ehrProvider: notesTable.ehrProvider,
  ehrDocumentRef: notesTable.ehrDocumentRef,
  ehrError: notesTable.ehrError,
  authorDisplayName: usersTable.displayName,
} as const;

type Row = {
  noteId: string;
  patientId: string;
  authorId: string | null;
  createdAt: Date;
  ehrPushedAt: Date | null;
  ehrProvider: string | null;
  ehrDocumentRef: string | null;
  ehrError: string | null;
  authorDisplayName: string | null;
};

function serialize(row: Row) {
  return {
    noteId: row.noteId,
    patientId: row.patientId,
    authorId: row.authorId,
    authorDisplayName: row.authorDisplayName,
    createdAt: row.createdAt,
    ehrPushedAt: row.ehrPushedAt,
    ehrProvider: row.ehrProvider,
    ehrDocumentRef: row.ehrDocumentRef,
    ehrError: row.ehrError,
  };
}

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

function readStringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

interface Cursor {
  createdAt: Date;
  id: string;
}

// Cursor is base64("<createdAtIso>|<noteId>"). Compound shape so
// pagination is stable across rows created in the same millisecond:
// the WHERE clause uses (createdAt, id) < (cursor.createdAt, cursor.id)
// in lexicographic order, matching the ORDER BY.
function encodeCursor(createdAt: Date, id: string): string {
  const raw = `${createdAt.toISOString()}|${id}`;
  return Buffer.from(raw, "utf8").toString("base64");
}

function decodeCursor(value: unknown): Cursor | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  let raw: string;
  try {
    raw = Buffer.from(value, "base64").toString("utf8");
  } catch {
    return undefined;
  }
  const sep = raw.indexOf("|");
  if (sep < 0) return undefined;
  const iso = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (!id) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return { createdAt: d, id };
}

router.get("/", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;

  const limit = clampLimit(req.query["limit"]);
  const userIdFilter = readStringParam(req.query["userId"]);
  const from = parseIsoDate(req.query["from"]);
  const to = parseIsoDate(req.query["to"]);
  const cursor = decodeCursor(req.query["cursor"]);

  // Always-on filters: tenant scope + auto_pushed_without_review = true.
  const conditions: SQL[] = [
    eq(notesTable.organizationId, orgId),
    eq(notesTable.autoPushedWithoutReview, true),
  ];
  if (userIdFilter) conditions.push(eq(notesTable.authorId, userIdFilter));
  if (from) conditions.push(gte(notesTable.createdAt, from));
  if (to) conditions.push(lte(notesTable.createdAt, to));
  if (cursor) {
    // Compound (createdAt, id) DESC comparison: row is "before" the
    // cursor if createdAt < cursor.createdAt, OR (createdAt == and id <).
    // Keeps pagination stable when multiple rows share createdAt to the
    // millisecond.
    const compound = or(
      lt(notesTable.createdAt, cursor.createdAt),
      and(
        eq(notesTable.createdAt, cursor.createdAt),
        lt(notesTable.id, cursor.id),
      ),
    );
    if (compound) conditions.push(compound);
  }

  const db = getDb();
  // Fetch limit+1 to know if there's another page without a count query.
  const rows = await db
    .select(autoPushedSelect)
    .from(notesTable)
    .leftJoin(usersTable, eq(notesTable.authorId, usersTable.id))
    .where(and(...conditions))
    .orderBy(desc(notesTable.createdAt), desc(notesTable.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const tail = page[page.length - 1];
  const nextCursor =
    hasMore && tail ? encodeCursor(tail.createdAt, tail.noteId) : null;

  res.json({ data: page.map(serialize), nextCursor });
});

export default router;
