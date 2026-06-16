import { Router, type IRouter } from "express";
import { and, asc, eq, max } from "drizzle-orm";
import {
  CreateTemplateBody,
  ReorderTemplatesBody,
  UpdateTemplateBody,
} from "@workspace/api-zod";
import { getDb, noteTemplatesTable } from "@workspace/db";
import { DEFAULT_TEMPLATES } from "../lib/default-templates";
import { getActiveOrgId } from "../lib/active-org";

const router: IRouter = Router();

interface SerializedTemplate {
  id: string;
  name: string;
  voiceCue: string | null;
  body: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

function serialize(row: typeof noteTemplatesTable.$inferSelect): SerializedTemplate {
  return {
    id: row.id,
    name: row.name,
    voiceCue: row.voiceCue,
    body: row.body,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Voice cues are matched case-insensitively, so we store the lowercased
// form. Empty string is treated as null — the API contract says voiceCue
// nullable, no point keeping a "" sentinel in the DB.
function normalizeCue(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
}

// Always scope by (userId, organizationId). A user who switches between
// two orgs gets two distinct template lists; cross-org reads must not
// return rows even if the userId matches.
async function listForUser(
  userId: string,
  organizationId: string,
): Promise<SerializedTemplate[]> {
  const rows = await getDb()
    .select()
    .from(noteTemplatesTable)
    .where(
      and(
        eq(noteTemplatesTable.userId, userId),
        eq(noteTemplatesTable.organizationId, organizationId),
      ),
    )
    .orderBy(asc(noteTemplatesTable.sortOrder), asc(noteTemplatesTable.createdAt));
  return rows.map(serialize);
}

async function seedDefaults(
  userId: string,
  organizationId: string,
): Promise<SerializedTemplate[]> {
  const rows = await getDb()
    .insert(noteTemplatesTable)
    .values(
      DEFAULT_TEMPLATES.map((t, i) => ({
        userId,
        organizationId,
        name: t.name,
        voiceCue: normalizeCue(t.voiceCue),
        body: t.body,
        sortOrder: (i + 1) * 10,
      })),
    )
    .returning();
  return rows.map(serialize);
}

router.get("/templates", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const existing = await listForUser(user.id, orgId);
  if (existing.length > 0) {
    res.json({ data: existing });
    return;
  }
  // First-time call: hand the provider a starter set so they're not
  // staring at an empty list. Idempotent — repeat zero-row calls keep
  // re-seeding, but only when the user has actively deleted every
  // template, which is rare.
  const seeded = await seedDefaults(user.id, orgId);
  res.json({ data: seeded });
});

router.post("/templates", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const parsed = CreateTemplateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_request",
      issues: parsed.error.issues,
    });
    return;
  }

  const cue = normalizeCue(parsed.data.voiceCue);
  if (cue) {
    const [collision] = await getDb()
      .select({ id: noteTemplatesTable.id })
      .from(noteTemplatesTable)
      .where(
        and(
          eq(noteTemplatesTable.userId, user.id),
          eq(noteTemplatesTable.organizationId, orgId),
          eq(noteTemplatesTable.voiceCue, cue),
        ),
      )
      .limit(1);
    if (collision) {
      res.status(409).json({ error: "voice_cue_in_use" });
      return;
    }
  }

  // New rows land at the bottom of the list — sortOrder is one bump
  // past the current max. Manual reorder via PUT /templates handles
  // the rest.
  const [maxRow] = await getDb()
    .select({ value: max(noteTemplatesTable.sortOrder) })
    .from(noteTemplatesTable)
    .where(
      and(
        eq(noteTemplatesTable.userId, user.id),
        eq(noteTemplatesTable.organizationId, orgId),
      ),
    );
  const nextSortOrder = (maxRow?.value ?? 0) + 10;

  try {
    const [inserted] = await getDb()
      .insert(noteTemplatesTable)
      .values({
        userId: user.id,
        organizationId: orgId,
        name: parsed.data.name,
        voiceCue: cue,
        body: parsed.data.body,
        sortOrder: nextSortOrder,
      })
      .returning();
    if (!inserted) {
      throw new Error("Insert returned no row");
    }
    res.status(201).json(serialize(inserted));
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: "voice_cue_in_use" });
      return;
    }
    req.log.error({ err }, "Failed to insert template");
    res.status(500).json({ error: "persistence_failed" });
  }
});

router.patch("/templates/:id", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const parsed = UpdateTemplateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_request",
      issues: parsed.error.issues,
    });
    return;
  }
  const id = req.params.id;
  const db = getDb();
  const [existing] = await db
    .select()
    .from(noteTemplatesTable)
    .where(
      and(
        eq(noteTemplatesTable.id, id),
        eq(noteTemplatesTable.userId, user.id),
        eq(noteTemplatesTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "template_not_found" });
    return;
  }

  const updates: Partial<typeof noteTemplatesTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.body !== undefined) updates.body = parsed.data.body;
  // voiceCue is allowed to be null — distinguish "field not provided"
  // (undefined) from "explicitly clear it" (null).
  if (parsed.data.voiceCue !== undefined) {
    const nextCue = normalizeCue(parsed.data.voiceCue);
    if (nextCue && nextCue !== existing.voiceCue) {
      const [collision] = await db
        .select({ id: noteTemplatesTable.id })
        .from(noteTemplatesTable)
        .where(
          and(
            eq(noteTemplatesTable.userId, user.id),
            eq(noteTemplatesTable.organizationId, orgId),
            eq(noteTemplatesTable.voiceCue, nextCue),
          ),
        )
        .limit(1);
      if (collision && collision.id !== id) {
        res.status(409).json({ error: "voice_cue_in_use" });
        return;
      }
    }
    updates.voiceCue = nextCue;
  }

  try {
    const [updated] = await db
      .update(noteTemplatesTable)
      .set(updates)
      .where(
        and(
          eq(noteTemplatesTable.id, id),
          eq(noteTemplatesTable.userId, user.id),
          eq(noteTemplatesTable.organizationId, orgId),
        ),
      )
      .returning();
    if (!updated) {
      res.status(404).json({ error: "template_not_found" });
      return;
    }
    res.json(serialize(updated));
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: "voice_cue_in_use" });
      return;
    }
    req.log.error({ err, id }, "Failed to update template");
    res.status(500).json({ error: "persistence_failed" });
  }
});

router.delete("/templates/:id", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const id = req.params.id;
  const result = await getDb()
    .delete(noteTemplatesTable)
    .where(
      and(
        eq(noteTemplatesTable.id, id),
        eq(noteTemplatesTable.userId, user.id),
        eq(noteTemplatesTable.organizationId, orgId),
      ),
    )
    .returning({ id: noteTemplatesTable.id });
  if (result.length === 0) {
    res.status(404).json({ error: "template_not_found" });
    return;
  }
  res.status(204).end();
});

router.put("/templates", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const parsed = ReorderTemplatesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_request",
      issues: parsed.error.issues,
    });
    return;
  }
  const db = getDb();
  const ownedRows = await db
    .select({ id: noteTemplatesTable.id })
    .from(noteTemplatesTable)
    .where(
      and(
        eq(noteTemplatesTable.userId, user.id),
        eq(noteTemplatesTable.organizationId, orgId),
      ),
    );
  const ownedIds = new Set(ownedRows.map((r) => r.id));
  const submittedIds = parsed.data.ids;

  // Reject if the submitted list doesn't match the caller's owned set
  // exactly (no foreign ids, no missing ids). Allowing partial reorders
  // would leave the rest of the list in an unspecified order.
  if (submittedIds.length !== ownedIds.size) {
    res.status(400).json({ error: "ids_mismatch" });
    return;
  }
  for (const id of submittedIds) {
    if (!ownedIds.has(id)) {
      res.status(400).json({ error: "ids_mismatch" });
      return;
    }
  }

  // Multiplicative gaps so a later single-row reorder doesn't have to
  // rewrite the whole list.
  await db.transaction(async (tx) => {
    for (let i = 0; i < submittedIds.length; i++) {
      const id = submittedIds[i];
      if (!id) continue;
      await tx
        .update(noteTemplatesTable)
        .set({ sortOrder: (i + 1) * 10, updatedAt: new Date() })
        .where(
          and(
            eq(noteTemplatesTable.id, id),
            eq(noteTemplatesTable.userId, user.id),
            eq(noteTemplatesTable.organizationId, orgId),
          ),
        );
    }
  });

  const fresh = await listForUser(user.id, orgId);
  res.json({ data: fresh });
});

router.post("/templates/reset", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx
      .delete(noteTemplatesTable)
      .where(
        and(
          eq(noteTemplatesTable.userId, user.id),
          eq(noteTemplatesTable.organizationId, orgId),
        ),
      );
    await tx.insert(noteTemplatesTable).values(
      DEFAULT_TEMPLATES.map((t, i) => ({
        userId: user.id,
        organizationId: orgId,
        name: t.name,
        voiceCue: normalizeCue(t.voiceCue),
        body: t.body,
        sortOrder: (i + 1) * 10,
      })),
    );
  });
  const fresh = await listForUser(user.id, orgId);
  res.json({ data: fresh });
});

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  if (e.code === "23505") return true;
  if (e.cause && typeof e.cause === "object" && e.cause.code === "23505") {
    return true;
  }
  return false;
}

export default router;
