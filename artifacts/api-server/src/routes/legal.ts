import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  resolveAllRequiredDocuments,
  resolveDocumentByVersion,
  type LegalDocumentType,
} from "../lib/legal-resolver";
import { getDb, legalAcceptancesTable, usersTable } from "@workspace/db";

// An acceptance row only counts as "current" if it's both for the
// current version AND was clicked after any founder-imposed
// reaccept-required timestamp. Keeping this comparison in one place
// so the read endpoint and the middleware stay in sync.
function isCurrent(
  acceptance: AcceptanceRow | undefined,
  currentVersion: string,
  reacceptRequiredAt: Date | null,
): boolean {
  if (!acceptance) return false;
  if (acceptance.version !== currentVersion) return false;
  if (reacceptRequiredAt && acceptance.acceptedAt <= reacceptRequiredAt) {
    return false;
  }
  return true;
}

const router: IRouter = Router();

type AcceptanceRow = typeof legalAcceptancesTable.$inferSelect;

interface AgreementStatus {
  type: LegalDocumentType;
  title: string;
  summary: string;
  currentVersion: string;
  body: string;
  contentHash: string;
  accepted: boolean;
  acceptedAt?: string;
}

// Look up the latest acceptance row per (user × documentType). We
// fetch all rows for the user once (the set is tiny — bounded by the
// number of document types they've ever accepted) and pick the most
// recent per type in memory. Doing this with a per-type query would
// fan out N round trips for zero correctness gain.
async function latestAcceptancesForUser(
  userId: string,
): Promise<Map<string, AcceptanceRow>> {
  const rows = await getDb()
    .select()
    .from(legalAcceptancesTable)
    .where(eq(legalAcceptancesTable.userId, userId))
    .orderBy(desc(legalAcceptancesTable.acceptedAt));
  const latest = new Map<string, AcceptanceRow>();
  for (const r of rows) {
    // First write wins because rows are pre-sorted by acceptedAt desc.
    if (!latest.has(r.documentType)) latest.set(r.documentType, r);
  }
  return latest;
}

router.get("/legal/agreements", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const required = await resolveAllRequiredDocuments();
  const latest = await latestAcceptancesForUser(user.id);
  const reacceptRequiredAt = user.legalReacceptRequiredAt;

  const data: AgreementStatus[] = required.map((doc) => {
    const acceptance = latest.get(doc.type);
    const accepted = isCurrent(
      acceptance,
      doc.currentVersion,
      reacceptRequiredAt,
    );
    return {
      type: doc.type,
      title: doc.title,
      summary: doc.summary,
      currentVersion: doc.currentVersion,
      body: doc.body,
      contentHash: doc.contentHash,
      accepted,
      ...(accepted && acceptance
        ? { acceptedAt: acceptance.acceptedAt.toISOString() }
        : {}),
    };
  });

  res.json({ data });
});

interface AcceptBody {
  acceptances: Array<{
    type: string;
    version: string;
    contentHash: string;
  }>;
}

function parseAcceptBody(body: unknown): AcceptBody | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { acceptances?: unknown };
  if (!Array.isArray(b.acceptances) || b.acceptances.length === 0) return null;
  const out: AcceptBody["acceptances"] = [];
  for (const item of b.acceptances) {
    if (!item || typeof item !== "object") return null;
    const i = item as {
      type?: unknown;
      version?: unknown;
      contentHash?: unknown;
    };
    if (
      typeof i.type !== "string" ||
      typeof i.version !== "string" ||
      typeof i.contentHash !== "string"
    ) {
      return null;
    }
    out.push({
      type: i.type,
      version: i.version,
      contentHash: i.contentHash,
    });
  }
  return { acceptances: out };
}

const VALID_TYPES = new Set<LegalDocumentType>(["baa", "terms", "privacy"]);

function isValidType(t: string): t is LegalDocumentType {
  return VALID_TYPES.has(t as LegalDocumentType);
}

// Trust the first hop's Forwarded / X-Forwarded-For when running
// behind a proxy; fall back to the socket address. Stored verbatim
// for audit purposes — we explicitly do NOT trust this as a security
// control.
function clientIp(req: { ip?: string; socket?: { remoteAddress?: string } }): string | null {
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

router.post("/legal/accept", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const parsed = parseAcceptBody(req.body);
  if (!parsed) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  // Validate every acceptance against the in-repo source of truth
  // BEFORE writing anything. If any single item is bogus (unknown
  // type, wrong version, stale hash) we reject the whole batch — no
  // partial state on the audit trail.
  const verified: Array<{
    type: LegalDocumentType;
    version: string;
    contentHash: string;
  }> = [];
  for (const item of parsed.acceptances) {
    if (!isValidType(item.type)) {
      res.status(400).json({ error: "unknown_document_type", item });
      return;
    }
    const resolved = await resolveDocumentByVersion(item.type, item.version);
    if (!resolved) {
      res.status(400).json({ error: "unknown_document_version", item });
      return;
    }
    const actualHash = resolved.contentHash;
    if (actualHash !== item.contentHash) {
      // The client is echoing a stale hash — usually because they
      // grabbed the agreements page before we shipped a new version.
      // Refuse rather than persist a record that won't verify later.
      res.status(400).json({ error: "content_hash_mismatch", item });
      return;
    }
    verified.push({
      type: item.type,
      version: item.version,
      contentHash: actualHash,
    });
  }

  const ip = clientIp(req);
  const userAgent =
    typeof req.headers["user-agent"] === "string"
      ? req.headers["user-agent"].slice(0, 1024)
      : null;

  // Append-only insert per item. We don't dedupe in app code — a
  // second row for the same (user, type, version) is informational
  // (they re-clicked), not an error, and the latest-by-time read on
  // GET handles it naturally.
  const db = getDb();
  await db.insert(legalAcceptancesTable).values(
    verified.map((v) => ({
      userId: user.id,
      documentType: v.type,
      version: v.version,
      contentHash: v.contentHash,
      ipAddress: ip,
      userAgent,
    })),
  );

  // Return the fresh status so the client can advance without a
  // follow-up GET round trip. We re-read the user row to pick up any
  // reaccept-required timestamp the founder set since this request
  // landed.
  const [refreshed] = await db
    .select({ legalReacceptRequiredAt: usersTable.legalReacceptRequiredAt })
    .from(usersTable)
    .where(eq(usersTable.id, user.id))
    .limit(1);
  const required = await resolveAllRequiredDocuments();
  const latest = await latestAcceptancesForUser(user.id);
  const reacceptRequiredAt = refreshed?.legalReacceptRequiredAt ?? null;
  const data: AgreementStatus[] = required.map((doc) => {
    const acceptance = latest.get(doc.type);
    const accepted = isCurrent(
      acceptance,
      doc.currentVersion,
      reacceptRequiredAt,
    );
    return {
      type: doc.type,
      title: doc.title,
      summary: doc.summary,
      currentVersion: doc.currentVersion,
      body: doc.body,
      contentHash: doc.contentHash,
      accepted,
      ...(accepted && acceptance
        ? { acceptedAt: acceptance.acceptedAt.toISOString() }
        : {}),
    };
  });

  // Silence the "unused" warning for `and` until we add the
  // withdrawn-row filter in a future revision.
  void and;
  res.json({ data });
});

export default router;
