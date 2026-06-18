import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  CreateSmartPhraseBody,
  UpdateSmartPhraseBody,
} from "@workspace/api-zod";
import { getDb, smartPhrasesTable } from "@workspace/db";
import { getActiveOrgId } from "../lib/active-org";

const router: IRouter = Router();

interface SerializedSmartPhrase {
  id: string;
  shortcut: string;
  body: string;
  description: string | null;
  usageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

function serialize(
  row: typeof smartPhrasesTable.$inferSelect,
): SerializedSmartPhrase {
  return {
    id: row.id,
    shortcut: row.shortcut,
    body: row.body,
    description: row.description,
    usageCount: row.usageCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Stored shortcuts are lowercased + trimmed. Reject whitespace and dot
// characters here so the autocomplete contract ("everything after `.`
// up to the next non-word char") holds.
function normalizeShortcut(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  if (/[\s.]/.test(trimmed)) return null;
  return trimmed;
}

function normalizeDescription(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

async function listForUser(
  userId: string,
  organizationId: string,
): Promise<SerializedSmartPhrase[]> {
  const rows = await getDb()
    .select()
    .from(smartPhrasesTable)
    .where(
      and(
        eq(smartPhrasesTable.userId, userId),
        eq(smartPhrasesTable.organizationId, organizationId),
      ),
    );
  // Sort in app code rather than the DB: typical list is a few dozen
  // rows and the editor refetches once per session, so the cost is
  // negligible and we avoid an index just for the ranking dimension.
  rows.sort((a, b) => {
    if (b.usageCount !== a.usageCount) return b.usageCount - a.usageCount;
    return a.shortcut.localeCompare(b.shortcut);
  });
  return rows.map(serialize);
}

router.get("/smart-phrases", async (req, res) => {
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

router.post("/smart-phrases", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const parsed = CreateSmartPhraseBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "invalid_request", issues: parsed.error.issues });
    return;
  }

  const shortcut = normalizeShortcut(parsed.data.shortcut);
  if (!shortcut) {
    res.status(400).json({ error: "invalid_shortcut" });
    return;
  }
  const body = parsed.data.body.trim();
  if (!body) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }
  const description = normalizeDescription(parsed.data.description);

  // Pre-check for the common collision case; the LOWER() unique index
  // is still the source of truth on race.
  const [existing] = await getDb()
    .select({ id: smartPhrasesTable.id })
    .from(smartPhrasesTable)
    .where(
      and(
        eq(smartPhrasesTable.userId, user.id),
        eq(smartPhrasesTable.organizationId, orgId),
        sql`lower(${smartPhrasesTable.shortcut}) = ${shortcut}`,
      ),
    )
    .limit(1);
  if (existing) {
    res.status(409).json({ error: "shortcut_in_use" });
    return;
  }

  try {
    const [inserted] = await getDb()
      .insert(smartPhrasesTable)
      .values({
        userId: user.id,
        organizationId: orgId,
        shortcut,
        body,
        description,
      })
      .returning();
    if (!inserted) throw new Error("Insert returned no row");
    res.status(201).json(serialize(inserted));
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: "shortcut_in_use" });
      return;
    }
    req.log.error({ err }, "Failed to insert smart phrase");
    res.status(500).json({ error: "persistence_failed" });
  }
});

router.patch("/smart-phrases/:id", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const parsed = UpdateSmartPhraseBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "invalid_request", issues: parsed.error.issues });
    return;
  }
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }
  const db = getDb();
  const [existing] = await db
    .select()
    .from(smartPhrasesTable)
    .where(
      and(
        eq(smartPhrasesTable.id, id),
        eq(smartPhrasesTable.userId, user.id),
        eq(smartPhrasesTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "smart_phrase_not_found" });
    return;
  }

  const updates: Partial<typeof smartPhrasesTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (parsed.data.shortcut !== undefined) {
    const nextShortcut = normalizeShortcut(parsed.data.shortcut);
    if (!nextShortcut) {
      res.status(400).json({ error: "invalid_shortcut" });
      return;
    }
    if (nextShortcut !== existing.shortcut) {
      const [collision] = await db
        .select({ id: smartPhrasesTable.id })
        .from(smartPhrasesTable)
        .where(
          and(
            eq(smartPhrasesTable.userId, user.id),
            eq(smartPhrasesTable.organizationId, orgId),
            sql`lower(${smartPhrasesTable.shortcut}) = ${nextShortcut}`,
          ),
        )
        .limit(1);
      if (collision && collision.id !== id) {
        res.status(409).json({ error: "shortcut_in_use" });
        return;
      }
    }
    updates.shortcut = nextShortcut;
  }
  if (parsed.data.body !== undefined) {
    const trimmed = parsed.data.body.trim();
    if (!trimmed) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    updates.body = trimmed;
  }
  if (parsed.data.description !== undefined) {
    updates.description = normalizeDescription(parsed.data.description);
  }

  try {
    const [updated] = await db
      .update(smartPhrasesTable)
      .set(updates)
      .where(
        and(
          eq(smartPhrasesTable.id, id),
          eq(smartPhrasesTable.userId, user.id),
          eq(smartPhrasesTable.organizationId, orgId),
        ),
      )
      .returning();
    if (!updated) {
      res.status(404).json({ error: "smart_phrase_not_found" });
      return;
    }
    res.json(serialize(updated));
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: "shortcut_in_use" });
      return;
    }
    req.log.error({ err }, "Failed to update smart phrase");
    res.status(500).json({ error: "persistence_failed" });
  }
});

router.delete("/smart-phrases/:id", async (req, res) => {
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
    .delete(smartPhrasesTable)
    .where(
      and(
        eq(smartPhrasesTable.id, id),
        eq(smartPhrasesTable.userId, user.id),
        eq(smartPhrasesTable.organizationId, orgId),
      ),
    )
    .returning({ id: smartPhrasesTable.id });
  if (result.length === 0) {
    res.status(404).json({ error: "smart_phrase_not_found" });
    return;
  }
  res.status(204).end();
});

router.post("/smart-phrases/:id/used", async (req, res) => {
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
  // Atomic increment so concurrent fires from a fast-typing provider
  // (or the same phrase fired twice in adjacent ticks) don't race the
  // counter. RETURNING checks ownership and existence in one round-trip.
  const result = await getDb()
    .update(smartPhrasesTable)
    .set({ usageCount: sql`${smartPhrasesTable.usageCount} + 1` })
    .where(
      and(
        eq(smartPhrasesTable.id, id),
        eq(smartPhrasesTable.userId, user.id),
        eq(smartPhrasesTable.organizationId, orgId),
      ),
    )
    .returning({ id: smartPhrasesTable.id });
  if (result.length === 0) {
    res.status(404).json({ error: "smart_phrase_not_found" });
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
