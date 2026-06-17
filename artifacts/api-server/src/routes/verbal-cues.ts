import { Router, type IRouter } from "express";
import { and, asc, eq, sql } from "drizzle-orm";
import { CreateVerbalCueBody } from "@workspace/api-zod";
import { getDb, providerVerbalCuesTable } from "@workspace/db";
import { getActiveOrgId } from "../lib/active-org";

const router: IRouter = Router();

interface SerializedVerbalCue {
  id: string;
  phrase: string;
  createdAt: Date;
  updatedAt: Date;
}

function serialize(
  row: typeof providerVerbalCuesTable.$inferSelect,
): SerializedVerbalCue {
  return {
    id: row.id,
    phrase: row.phrase,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

router.get("/verbal-cues", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const rows = await getDb()
    .select()
    .from(providerVerbalCuesTable)
    .where(
      and(
        eq(providerVerbalCuesTable.userId, user.id),
        eq(providerVerbalCuesTable.organizationId, orgId),
      ),
    )
    .orderBy(asc(providerVerbalCuesTable.createdAt));
  res.json({ data: rows.map(serialize) });
});

router.post("/verbal-cues", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const parsed = CreateVerbalCueBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "invalid_request", issues: parsed.error.issues });
    return;
  }
  const phrase = parsed.data.phrase.trim();
  if (!phrase) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  // Pre-check on the LOWER(phrase) unique constraint so the common
  // case returns 409 without going through a DB error path.
  const [existing] = await getDb()
    .select({ id: providerVerbalCuesTable.id })
    .from(providerVerbalCuesTable)
    .where(
      and(
        eq(providerVerbalCuesTable.userId, user.id),
        eq(providerVerbalCuesTable.organizationId, orgId),
        sql`lower(${providerVerbalCuesTable.phrase}) = lower(${phrase})`,
      ),
    )
    .limit(1);
  if (existing) {
    res.status(409).json({ error: "phrase_in_use" });
    return;
  }

  try {
    const [inserted] = await getDb()
      .insert(providerVerbalCuesTable)
      .values({
        userId: user.id,
        organizationId: orgId,
        phrase,
      })
      .returning();
    if (!inserted) throw new Error("Insert returned no row");
    res.status(201).json(serialize(inserted));
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: "phrase_in_use" });
      return;
    }
    req.log.error({ err }, "Failed to insert verbal cue");
    res.status(500).json({ error: "persistence_failed" });
  }
});

router.delete("/verbal-cues/:id", async (req, res) => {
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
    .delete(providerVerbalCuesTable)
    .where(
      and(
        eq(providerVerbalCuesTable.id, id),
        eq(providerVerbalCuesTable.userId, user.id),
        eq(providerVerbalCuesTable.organizationId, orgId),
      ),
    )
    .returning({ id: providerVerbalCuesTable.id });
  if (result.length === 0) {
    res.status(404).json({ error: "cue_not_found" });
    return;
  }
  res.status(204).end();
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
