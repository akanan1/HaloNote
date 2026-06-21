import { Router, type IRouter } from "express";
import { and, asc, eq, max, sql } from "drizzle-orm";
import {
  CreatePhraseMappingBody,
  UpdatePhraseMappingBody,
} from "@workspace/api-zod";
import { getDb, providerPhraseMappingsTable } from "@workspace/db";
import { getActiveOrgId } from "../lib/active-org";
import { isUniqueViolation, respondInvalidBody } from "../http";

const router: IRouter = Router();

interface SerializedPhraseMapping {
  id: string;
  spoken: string;
  documented: string;
  createdAt: Date;
  updatedAt: Date;
}

function serialize(
  row: typeof providerPhraseMappingsTable.$inferSelect,
): SerializedPhraseMapping {
  return {
    id: row.id,
    spoken: row.spoken,
    documented: row.documented,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function listForUser(
  userId: string,
  organizationId: string,
): Promise<SerializedPhraseMapping[]> {
  const rows = await getDb()
    .select()
    .from(providerPhraseMappingsTable)
    .where(
      and(
        eq(providerPhraseMappingsTable.userId, userId),
        eq(providerPhraseMappingsTable.organizationId, organizationId),
      ),
    )
    .orderBy(
      asc(providerPhraseMappingsTable.sortOrder),
      asc(providerPhraseMappingsTable.createdAt),
    );
  return rows.map(serialize);
}

router.get("/phrase-mappings", async (req, res) => {
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

router.post("/phrase-mappings", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const parsed = CreatePhraseMappingBody.safeParse(req.body);
  if (!parsed.success) return respondInvalidBody(res, parsed.error);

  const spoken = parsed.data.spoken.trim();
  const documented = parsed.data.documented.trim();
  if (!spoken || !documented) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  // Application-layer pre-check. The unique-on-LOWER(spoken) DB index
  // is the source of truth (race-safe), but checking first lets us
  // return a clean 409 without an exception path on the common
  // collision case.
  const [existing] = await getDb()
    .select({ id: providerPhraseMappingsTable.id })
    .from(providerPhraseMappingsTable)
    .where(
      and(
        eq(providerPhraseMappingsTable.userId, user.id),
        eq(providerPhraseMappingsTable.organizationId, orgId),
        sql`lower(${providerPhraseMappingsTable.spoken}) = lower(${spoken})`,
      ),
    )
    .limit(1);
  if (existing) {
    res.status(409).json({ error: "spoken_phrase_in_use" });
    return;
  }

  // New rows land at the bottom of the list. sort_order is stored as
  // text (matches the templates pattern); cast for the max query.
  const [maxRow] = await getDb()
    .select({
      value: max(sql<number>`(${providerPhraseMappingsTable.sortOrder})::int`),
    })
    .from(providerPhraseMappingsTable)
    .where(
      and(
        eq(providerPhraseMappingsTable.userId, user.id),
        eq(providerPhraseMappingsTable.organizationId, orgId),
      ),
    );
  const currentMax = maxRow?.value == null ? 0 : Number(maxRow.value);
  const nextSortOrder = String(currentMax + 10);

  try {
    const [inserted] = await getDb()
      .insert(providerPhraseMappingsTable)
      .values({
        userId: user.id,
        organizationId: orgId,
        spoken,
        documented,
        sortOrder: nextSortOrder,
      })
      .returning();
    if (!inserted) throw new Error("Insert returned no row");
    res.status(201).json(serialize(inserted));
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: "spoken_phrase_in_use" });
      return;
    }
    req.log.error({ err }, "Failed to insert phrase mapping");
    res.status(500).json({ error: "persistence_failed" });
  }
});

router.patch("/phrase-mappings/:id", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const parsed = UpdatePhraseMappingBody.safeParse(req.body);
  if (!parsed.success) return respondInvalidBody(res, parsed.error);
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }
  const db = getDb();
  const [existing] = await db
    .select()
    .from(providerPhraseMappingsTable)
    .where(
      and(
        eq(providerPhraseMappingsTable.id, id),
        eq(providerPhraseMappingsTable.userId, user.id),
        eq(providerPhraseMappingsTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "phrase_mapping_not_found" });
    return;
  }

  const updates: Partial<typeof providerPhraseMappingsTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (parsed.data.spoken !== undefined) {
    const trimmed = parsed.data.spoken.trim();
    if (!trimmed) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    // If the spoken phrase is changing case-insensitively, pre-check
    // for a collision so we can return 409 cleanly.
    if (trimmed.toLowerCase() !== existing.spoken.toLowerCase()) {
      const [collision] = await db
        .select({ id: providerPhraseMappingsTable.id })
        .from(providerPhraseMappingsTable)
        .where(
          and(
            eq(providerPhraseMappingsTable.userId, user.id),
            eq(providerPhraseMappingsTable.organizationId, orgId),
            sql`lower(${providerPhraseMappingsTable.spoken}) = lower(${trimmed})`,
          ),
        )
        .limit(1);
      if (collision) {
        res.status(409).json({ error: "spoken_phrase_in_use" });
        return;
      }
    }
    updates.spoken = trimmed;
  }
  if (parsed.data.documented !== undefined) {
    const trimmed = parsed.data.documented.trim();
    if (!trimmed) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    updates.documented = trimmed;
  }

  try {
    const [updated] = await db
      .update(providerPhraseMappingsTable)
      .set(updates)
      .where(
        and(
          eq(providerPhraseMappingsTable.id, id),
          eq(providerPhraseMappingsTable.userId, user.id),
          eq(providerPhraseMappingsTable.organizationId, orgId),
        ),
      )
      .returning();
    if (!updated) {
      res.status(404).json({ error: "phrase_mapping_not_found" });
      return;
    }
    res.json(serialize(updated));
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: "spoken_phrase_in_use" });
      return;
    }
    req.log.error({ err }, "Failed to update phrase mapping");
    res.status(500).json({ error: "persistence_failed" });
  }
});

router.delete("/phrase-mappings/:id", async (req, res) => {
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
    .delete(providerPhraseMappingsTable)
    .where(
      and(
        eq(providerPhraseMappingsTable.id, id),
        eq(providerPhraseMappingsTable.userId, user.id),
        eq(providerPhraseMappingsTable.organizationId, orgId),
      ),
    )
    .returning({ id: providerPhraseMappingsTable.id });
  if (result.length === 0) {
    res.status(404).json({ error: "phrase_mapping_not_found" });
    return;
  }
  res.status(204).end();
});

export default router;
