import { Router, type IRouter } from "express";
import { respondInvalidBody } from "../http";
import { and, asc, eq, max, sql } from "drizzle-orm";
import {
  CreateNoteDefaultBody,
  UpdateNoteDefaultBody,
} from "@workspace/api-zod";
import { getDb, providerNoteDefaultsTable } from "@workspace/db";
import { NOTE_DEFAULT_SUGGESTIONS } from "../lib/note-default-suggestions";
import { getActiveOrgId } from "../lib/active-org";

const router: IRouter = Router();

interface SerializedNoteDefault {
  id: string;
  label: string;
  rule: string;
  createdAt: Date;
  updatedAt: Date;
}

function serialize(
  row: typeof providerNoteDefaultsTable.$inferSelect,
): SerializedNoteDefault {
  return {
    id: row.id,
    label: row.label,
    rule: row.rule,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function listForUser(
  userId: string,
  organizationId: string,
): Promise<SerializedNoteDefault[]> {
  const rows = await getDb()
    .select()
    .from(providerNoteDefaultsTable)
    .where(
      and(
        eq(providerNoteDefaultsTable.userId, userId),
        eq(providerNoteDefaultsTable.organizationId, organizationId),
      ),
    )
    .orderBy(
      asc(providerNoteDefaultsTable.sortOrder),
      asc(providerNoteDefaultsTable.createdAt),
    );
  return rows.map(serialize);
}

// Suggestions list — served as a static catalog. Public to any
// authenticated user; no per-user state.
router.get("/note-defaults/suggestions", (req, res) => {
  if (!req.user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  res.json({ data: NOTE_DEFAULT_SUGGESTIONS });
});

router.get("/note-defaults", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const data = await listForUser(user.id, orgId);
  res.json({ data });
});

router.post("/note-defaults", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const parsed = CreateNoteDefaultBody.safeParse(req.body);
  if (!parsed.success) return respondInvalidBody(res, parsed.error);
  const label = parsed.data.label.trim();
  const rule = parsed.data.rule.trim();
  if (!label || !rule) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  const [maxRow] = await getDb()
    .select({
      value: max(sql<number>`(${providerNoteDefaultsTable.sortOrder})::int`),
    })
    .from(providerNoteDefaultsTable)
    .where(
      and(
        eq(providerNoteDefaultsTable.userId, user.id),
        eq(providerNoteDefaultsTable.organizationId, orgId),
      ),
    );
  const currentMax = maxRow?.value == null ? 0 : Number(maxRow.value);
  const nextSortOrder = String(currentMax + 10);

  try {
    const [inserted] = await getDb()
      .insert(providerNoteDefaultsTable)
      .values({
        userId: user.id,
        organizationId: orgId,
        label,
        rule,
        sortOrder: nextSortOrder,
      })
      .returning();
    if (!inserted) throw new Error("Insert returned no row");
    res.status(201).json(serialize(inserted));
  } catch (err) {
    req.log.error({ err }, "Failed to insert note default");
    res.status(500).json({ error: "persistence_failed" });
  }
});

router.patch("/note-defaults/:id", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const parsed = UpdateNoteDefaultBody.safeParse(req.body);
  if (!parsed.success) return respondInvalidBody(res, parsed.error);
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }
  const updates: Partial<typeof providerNoteDefaultsTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (parsed.data.label !== undefined) {
    const trimmed = parsed.data.label.trim();
    if (!trimmed) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    updates.label = trimmed;
  }
  if (parsed.data.rule !== undefined) {
    const trimmed = parsed.data.rule.trim();
    if (!trimmed) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    updates.rule = trimmed;
  }

  const [updated] = await getDb()
    .update(providerNoteDefaultsTable)
    .set(updates)
    .where(
      and(
        eq(providerNoteDefaultsTable.id, id),
        eq(providerNoteDefaultsTable.userId, user.id),
        eq(providerNoteDefaultsTable.organizationId, orgId),
      ),
    )
    .returning();
  if (!updated) {
    res.status(404).json({ error: "note_default_not_found" });
    return;
  }
  res.json(serialize(updated));
});

router.delete("/note-defaults/:id", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }
  const result = await getDb()
    .delete(providerNoteDefaultsTable)
    .where(
      and(
        eq(providerNoteDefaultsTable.id, id),
        eq(providerNoteDefaultsTable.userId, user.id),
        eq(providerNoteDefaultsTable.organizationId, orgId),
      ),
    )
    .returning({ id: providerNoteDefaultsTable.id });
  if (result.length === 0) {
    res.status(404).json({ error: "note_default_not_found" });
    return;
  }
  res.status(204).end();
});

export default router;
