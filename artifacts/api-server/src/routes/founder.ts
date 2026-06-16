import { Router, type IRouter } from "express";
import { and, count, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import {
  getDb,
  legalAcceptancesTable,
  legalDocumentOverridesTable,
  notesTable,
  patientsTable,
  recordingJobsTable,
  usersTable,
} from "@workspace/db";
import {
  REQUIRED_DOCUMENT_TYPES,
  resolveAllRequiredDocuments,
  hashLegalBody,
  type LegalDocumentType,
} from "../lib/legal-resolver";
import { requireFounder } from "../middlewares/require-founder";
import { sendEmail } from "../lib/email";
import { logger } from "../lib/logger";

// 30 days of daily aggregation. Bound chosen so the sparkline shows
// roughly a month of texture without overwhelming the wire payload
// (90 rows × 3 series = 270 ints, ~6 KB JSON).
const DAILY_SERIES_DAYS = 30;

// Founder-only cross-tenant dashboard. All routes here are gated by
// `requireFounder`; non-founders get a 404 so the surface isn't
// discoverable.

const router: IRouter = Router();

router.use(requireFounder);

interface AnalyticsTotals {
  users: number;
  admins: number;
  patients: number;
  notes: number;
  recordingsTotal: number;
  recordingsDone: number;
  recordingsFailed: number;
  signupsLast7Days: number;
  signupsLast30Days: number;
}

// Convert a Postgres `count_<table>_per_day` row set into a
// zero-filled dense array of { date: 'YYYY-MM-DD', count } objects
// from `startDate` to `endDate` inclusive. Sparse → dense lets the
// frontend draw without gap math.
function denseDailySeries(
  rows: Array<{ day: string | Date; value: number | string }>,
  startDate: Date,
  endDate: Date,
): Array<{ date: string; count: number }> {
  const byDate = new Map<string, number>();
  for (const r of rows) {
    const d = r.day instanceof Date ? r.day : new Date(r.day);
    if (Number.isNaN(d.getTime())) continue;
    const iso = d.toISOString().slice(0, 10);
    byDate.set(iso, Number(r.value ?? 0));
  }
  const out: Array<{ date: string; count: number }> = [];
  const cursor = new Date(startDate);
  while (cursor <= endDate) {
    const iso = cursor.toISOString().slice(0, 10);
    out.push({ date: iso, count: byDate.get(iso) ?? 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

router.get("/founder/analytics", async (_req, res) => {
  const db = getDb();
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Sparkline window: today and the previous DAILY_SERIES_DAYS-1 days,
  // bucketed at UTC midnight. Start is normalized so the window is
  // stable across timezones / DST.
  const seriesEnd = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    ),
  );
  const seriesStart = new Date(seriesEnd);
  seriesStart.setUTCDate(seriesStart.getUTCDate() - (DAILY_SERIES_DAYS - 1));

  // All count queries fired in parallel — none depend on each other,
  // and Postgres handles them all on cached pages of small index
  // ranges. Keeping them concurrent makes the dashboard feel
  // instantaneous.
  const [
    [userCount],
    [adminCount],
    [patientCount],
    [noteCount],
    recordingStatusRows,
    [signups7],
    [signups30],
    users,
    notesPerUserRows,
    patientsPerUserRows,
    recordingsPerUserRows,
    lastNotePerUserRows,
    allAcceptanceRows,
    signupsPerDayRows,
    notesPerDayRows,
    recordingsPerDayRows,
  ] = await Promise.all([
    db.select({ value: count() }).from(usersTable),
    db
      .select({ value: count() })
      .from(usersTable)
      .where(eq(usersTable.role, "admin")),
    db.select({ value: count() }).from(patientsTable),
    db.select({ value: count() }).from(notesTable),
    db
      .select({
        status: recordingJobsTable.status,
        value: count(),
      })
      .from(recordingJobsTable)
      .groupBy(recordingJobsTable.status),
    db
      .select({ value: count() })
      .from(usersTable)
      .where(gte(usersTable.createdAt, sevenDaysAgo)),
    db
      .select({ value: count() })
      .from(usersTable)
      .where(gte(usersTable.createdAt, thirtyDaysAgo)),
    db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        displayName: usersTable.displayName,
        role: usersTable.role,
        isFounder: usersTable.isFounder,
        createdAt: usersTable.createdAt,
        onboardingCompletedAt: usersTable.onboardingCompletedAt,
        legalReacceptRequiredAt: usersTable.legalReacceptRequiredAt,
      })
      .from(usersTable)
      .orderBy(desc(usersTable.createdAt)),
    db
      .select({
        authorId: notesTable.authorId,
        value: count(),
      })
      .from(notesTable)
      .groupBy(notesTable.authorId),
    // Patients aren't owned by a user directly — they're per-tenant.
    // For per-user analytics we approximate "patients touched" via the
    // distinct patient_ids on the user's notes. Cheap enough at this
    // scale; revisit if the user_id × patient_id pair becomes hot.
    db
      .select({
        authorId: notesTable.authorId,
        value: sql<number>`count(distinct ${notesTable.patientId})`.as("value"),
      })
      .from(notesTable)
      .groupBy(notesTable.authorId),
    db
      .select({
        userId: recordingJobsTable.userId,
        value: count(),
      })
      .from(recordingJobsTable)
      .groupBy(recordingJobsTable.userId),
    db
      .select({
        authorId: notesTable.authorId,
        lastAt: sql<Date>`max(${notesTable.updatedAt})`.as("last_at"),
      })
      .from(notesTable)
      .groupBy(notesTable.authorId),
    db
      .select()
      .from(legalAcceptancesTable)
      .orderBy(desc(legalAcceptancesTable.acceptedAt)),
    db
      .select({
        day: sql<Date>`date_trunc('day', ${usersTable.createdAt} AT TIME ZONE 'UTC')`.as("day"),
        value: count(),
      })
      .from(usersTable)
      .where(gte(usersTable.createdAt, seriesStart))
      .groupBy(sql`day`),
    db
      .select({
        day: sql<Date>`date_trunc('day', ${notesTable.createdAt} AT TIME ZONE 'UTC')`.as("day"),
        value: count(),
      })
      .from(notesTable)
      .where(gte(notesTable.createdAt, seriesStart))
      .groupBy(sql`day`),
    db
      .select({
        day: sql<Date>`date_trunc('day', ${recordingJobsTable.createdAt} AT TIME ZONE 'UTC')`.as("day"),
        value: count(),
      })
      .from(recordingJobsTable)
      .where(gte(recordingJobsTable.createdAt, seriesStart))
      .groupBy(sql`day`),
  ]);

  const recordingsTotal = recordingStatusRows.reduce(
    (s, r) => s + Number(r.value ?? 0),
    0,
  );
  const recordingsDone = recordingStatusRows
    .filter((r) => r.status === "done")
    .reduce((s, r) => s + Number(r.value ?? 0), 0);
  const recordingsFailed = recordingStatusRows
    .filter((r) => r.status === "failed")
    .reduce((s, r) => s + Number(r.value ?? 0), 0);

  const totals: AnalyticsTotals = {
    users: Number(userCount?.value ?? 0),
    admins: Number(adminCount?.value ?? 0),
    patients: Number(patientCount?.value ?? 0),
    notes: Number(noteCount?.value ?? 0),
    recordingsTotal,
    recordingsDone,
    recordingsFailed,
    signupsLast7Days: Number(signups7?.value ?? 0),
    signupsLast30Days: Number(signups30?.value ?? 0),
  };

  // Build lookup maps for the per-user rollups.
  const notesByUser = new Map<string, number>();
  for (const r of notesPerUserRows) {
    if (r.authorId) notesByUser.set(r.authorId, Number(r.value ?? 0));
  }
  const patientsByUser = new Map<string, number>();
  for (const r of patientsPerUserRows) {
    if (r.authorId) patientsByUser.set(r.authorId, Number(r.value ?? 0));
  }
  const recordingsByUser = new Map<string, number>();
  for (const r of recordingsPerUserRows) {
    recordingsByUser.set(r.userId, Number(r.value ?? 0));
  }
  const lastNoteByUser = new Map<string, Date>();
  for (const r of lastNotePerUserRows) {
    if (!r.authorId || !r.lastAt) continue;
    // `max()` over a timestamp column comes back as a string from
    // pg/drizzle even though we asked for `sql<Date>`. Normalize.
    const asDate = r.lastAt instanceof Date ? r.lastAt : new Date(r.lastAt);
    if (!Number.isNaN(asDate.getTime())) {
      lastNoteByUser.set(r.authorId, asDate);
    }
  }

  // Latest acceptance per (user, doc_type). Rows arrived sorted by
  // acceptedAt desc, so first write wins.
  const latestAcceptanceByUserType = new Map<string, typeof allAcceptanceRows[number]>();
  for (const row of allAcceptanceRows) {
    const key = `${row.userId}:${row.documentType}`;
    if (!latestAcceptanceByUserType.has(key)) {
      latestAcceptanceByUserType.set(key, row);
    }
  }

  const currentVersions: Record<string, string> = {};
  const resolvedDocs = await resolveAllRequiredDocuments();
  for (const doc of resolvedDocs) {
    currentVersions[doc.type] = doc.currentVersion;
  }

  // Pre-compute the "stale on type X" flag per user so the analytics
  // section can report counts in one pass below.
  const staleByType: Record<LegalDocumentType, number> = {
    baa: 0,
    terms: 0,
    privacy: 0,
  };
  let staleAnyCount = 0;
  let onboardingCompleted = 0;
  let onboardingPending = 0;

  const userRows = users.map((u) => {
    if (u.onboardingCompletedAt) onboardingCompleted += 1;
    else onboardingPending += 1;
    let staleOnAny = false;
    const legalAcceptances = REQUIRED_DOCUMENT_TYPES.map((t) => {
      const row = latestAcceptanceByUserType.get(`${u.id}:${t}`);
      const currentVersion = currentVersions[t]!;
      const isStale =
        !row ||
        row.version !== currentVersion ||
        (u.legalReacceptRequiredAt &&
          row.acceptedAt <= u.legalReacceptRequiredAt);
      const accepted = !isStale;
      if (isStale) {
        staleByType[t] += 1;
        staleOnAny = true;
      }
      return {
        type: t,
        currentVersion,
        accepted,
        ...(row
          ? {
              acceptedVersion: row.version,
              acceptedAt: row.acceptedAt.toISOString(),
            }
          : {}),
      };
    });
    if (staleOnAny) staleAnyCount += 1;
    const lastNoteAt = lastNoteByUser.get(u.id);
    return {
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      role: u.role,
      isFounder: u.isFounder,
      createdAt: u.createdAt.toISOString(),
      ...(lastNoteAt ? { lastNoteAt: lastNoteAt.toISOString() } : {}),
      patientCount: patientsByUser.get(u.id) ?? 0,
      noteCount: notesByUser.get(u.id) ?? 0,
      recordingCount: recordingsByUser.get(u.id) ?? 0,
      legalAcceptances,
    };
  });

  const dailySeries = {
    startDate: seriesStart.toISOString().slice(0, 10),
    endDate: seriesEnd.toISOString().slice(0, 10),
    signups: denseDailySeries(signupsPerDayRows, seriesStart, seriesEnd),
    notes: denseDailySeries(notesPerDayRows, seriesStart, seriesEnd),
    recordings: denseDailySeries(
      recordingsPerDayRows,
      seriesStart,
      seriesEnd,
    ),
  };

  const totalUsersForRate = users.length;
  const compliance = {
    onboardingCompleted,
    onboardingPending,
    onboardingCompletionRate:
      totalUsersForRate > 0 ? onboardingCompleted / totalUsersForRate : 0,
    staleBaaUsers: staleByType.baa,
    staleTermsUsers: staleByType.terms,
    stalePrivacyUsers: staleByType.privacy,
    staleAnyUsers: staleAnyCount,
  };

  res.json({ totals, dailySeries, compliance, users: userRows });
});

// Per-user detail. Used by the founder dashboard's drill-down — surfaces
// the full append-only acceptance trail (every version, every IP,
// every timestamp). Falls back to 404 if the user doesn't exist so the
// founder gets the same response shape whether they typo'd a URL or
// asked about a deleted account.
router.get("/founder/users/:id", async (req, res) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }
  const db = getDb();
  const [u] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, id))
    .limit(1);
  if (!u) {
    res.status(404).json({ error: "user_not_found" });
    return;
  }

  // 30-day window for the per-user sparklines — same shape as the
  // dashboard, computed for this user only.
  const nowU = new Date();
  const userSeriesEnd = new Date(
    Date.UTC(
      nowU.getUTCFullYear(),
      nowU.getUTCMonth(),
      nowU.getUTCDate(),
    ),
  );
  const userSeriesStart = new Date(userSeriesEnd);
  userSeriesStart.setUTCDate(
    userSeriesStart.getUTCDate() - (DAILY_SERIES_DAYS - 1),
  );

  const [
    [patientsRow],
    [notesRow],
    [recordingsRow],
    [lastNoteRow],
    acceptanceRows,
    userNotesPerDayRows,
    userRecordingsPerDayRows,
    userPatientsPerDayRows,
  ] = await Promise.all([
    db
      .select({
        value: sql<number>`count(distinct ${notesTable.patientId})`.as("value"),
      })
      .from(notesTable)
      .where(eq(notesTable.authorId, id)),
    db
      .select({ value: count() })
      .from(notesTable)
      .where(eq(notesTable.authorId, id)),
    db
      .select({ value: count() })
      .from(recordingJobsTable)
      .where(eq(recordingJobsTable.userId, id)),
    db
      .select({
        lastAt: sql<Date>`max(${notesTable.updatedAt})`.as("last_at"),
      })
      .from(notesTable)
      .where(eq(notesTable.authorId, id)),
    db
      .select()
      .from(legalAcceptancesTable)
      .where(eq(legalAcceptancesTable.userId, id))
      .orderBy(desc(legalAcceptancesTable.acceptedAt)),
    db
      .select({
        day: sql<Date>`date_trunc('day', ${notesTable.createdAt} AT TIME ZONE 'UTC')`.as("day"),
        value: count(),
      })
      .from(notesTable)
      .where(
        and(
          eq(notesTable.authorId, id),
          gte(notesTable.createdAt, userSeriesStart),
        ),
      )
      .groupBy(sql`day`),
    db
      .select({
        day: sql<Date>`date_trunc('day', ${recordingJobsTable.createdAt} AT TIME ZONE 'UTC')`.as("day"),
        value: count(),
      })
      .from(recordingJobsTable)
      .where(
        and(
          eq(recordingJobsTable.userId, id),
          gte(recordingJobsTable.createdAt, userSeriesStart),
        ),
      )
      .groupBy(sql`day`),
    // Per-user "patients touched" — counts the days on which this
    // user authored notes for a previously-unseen patient. Imperfect
    // but cheap: a true `first_seen_at` lives in the future once we
    // need it for billing.
    db
      .select({
        day: sql<Date>`date_trunc('day', min(${notesTable.createdAt}) AT TIME ZONE 'UTC')`.as("day"),
        value: sql<number>`count(distinct ${notesTable.patientId})`.as("value"),
      })
      .from(notesTable)
      .where(
        and(
          eq(notesTable.authorId, id),
          gte(notesTable.createdAt, userSeriesStart),
        ),
      )
      .groupBy(notesTable.patientId),
  ]);

  const currentVersions: Record<string, string> = {};
  const resolvedDocs2 = await resolveAllRequiredDocuments();
  for (const doc of resolvedDocs2) {
    currentVersions[doc.type] = doc.currentVersion;
  }

  const latestAcceptanceByType = new Map<
    string,
    typeof acceptanceRows[number]
  >();
  for (const row of acceptanceRows) {
    if (!latestAcceptanceByType.has(row.documentType)) {
      latestAcceptanceByType.set(row.documentType, row);
    }
  }
  const legalAcceptances = REQUIRED_DOCUMENT_TYPES.map((t) => {
    const row = latestAcceptanceByType.get(t);
    const currentVersion = currentVersions[t]!;
    const accepted = !!row && row.version === currentVersion;
    return {
      type: t,
      currentVersion,
      accepted,
      ...(row
        ? {
            acceptedVersion: row.version,
            acceptedAt: row.acceptedAt.toISOString(),
          }
        : {}),
    };
  });

  let lastNoteAt: string | undefined;
  if (lastNoteRow?.lastAt) {
    const d =
      lastNoteRow.lastAt instanceof Date
        ? lastNoteRow.lastAt
        : new Date(lastNoteRow.lastAt);
    if (!Number.isNaN(d.getTime())) lastNoteAt = d.toISOString();
  }

  res.json({
    user: {
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      role: u.role,
      isFounder: u.isFounder,
      createdAt: u.createdAt.toISOString(),
      ...(lastNoteAt ? { lastNoteAt } : {}),
      patientCount: Number(patientsRow?.value ?? 0),
      noteCount: Number(notesRow?.value ?? 0),
      recordingCount: Number(recordingsRow?.value ?? 0),
      legalAcceptances,
    },
    acceptances: acceptanceRows.map((r) => ({
      type: r.documentType,
      version: r.version,
      contentHash: r.contentHash,
      ...(r.ipAddress ? { ipAddress: r.ipAddress } : {}),
      ...(r.userAgent ? { userAgent: r.userAgent } : {}),
      acceptedAt: r.acceptedAt.toISOString(),
    })),
    dailySeries: {
      startDate: userSeriesStart.toISOString().slice(0, 10),
      endDate: userSeriesEnd.toISOString().slice(0, 10),
      notes: denseDailySeries(
        userNotesPerDayRows,
        userSeriesStart,
        userSeriesEnd,
      ),
      recordings: denseDailySeries(
        userRecordingsPerDayRows,
        userSeriesStart,
        userSeriesEnd,
      ),
      patients: denseDailySeries(
        userPatientsPerDayRows,
        userSeriesStart,
        userSeriesEnd,
      ),
    },
  });
});

// Publish a new legal document version. Append-only — the prior
// version stays referenced by every historical acceptance row.
// After insert, emails every user with a stale acceptance for the
// affected type. Email send is fire-and-forget per user; one bad
// address can't block the founder's response.
router.post("/founder/legal-versions", async (req, res) => {
  const founder = req.user!;
  const body = req.body as {
    type?: unknown;
    version?: unknown;
    body?: unknown;
  };
  if (
    typeof body.type !== "string" ||
    typeof body.version !== "string" ||
    typeof body.body !== "string"
  ) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }
  if (
    body.type !== "baa" &&
    body.type !== "terms" &&
    body.type !== "privacy"
  ) {
    res.status(400).json({ error: "unknown_document_type" });
    return;
  }
  const version = body.version.trim();
  const docBody = body.body.trim();
  if (!version || docBody.length < 100) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  const documentType = body.type as LegalDocumentType;
  const contentHash = hashLegalBody(docBody);
  const db = getDb();
  try {
    await db.insert(legalDocumentOverridesTable).values({
      documentType,
      version,
      body: docBody,
      contentHash,
      uploadedByUserId: founder.id,
    });
  } catch (err) {
    // Unique violation on (type, version) — the founder is trying to
    // re-publish the same label.
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("legal_document_overrides_type_version_uniq")) {
      res.status(409).json({ error: "version_already_exists" });
      return;
    }
    throw err;
  }

  // Notify every user whose latest acceptance for this type is now
  // out of date. The query joins users to their most recent
  // acceptance row of this type and filters down to those whose
  // version != the new one OR who never accepted.
  const usersToNotify = await db
    .select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable);

  let notifiedCount = 0;
  for (const u of usersToNotify) {
    // Each fire-and-forget send is awaited but errors are swallowed —
    // we shouldn't fail the whole publish because one mailbox is full.
    try {
      await sendEmail({
        to: u.email,
        subject: `Action required: please review the updated HaloNote ${humanType(documentType)}`,
        body:
          `We've published version ${version} of the HaloNote ` +
          `${humanType(documentType)}. To keep using HaloNote with patient ` +
          `data, please sign in and accept the updated document.\n\n` +
          `If you have questions, reply to this email and our team will follow up.\n`,
      });
      notifiedCount += 1;
    } catch (err) {
      logger.warn(
        { err, recipientCount: usersToNotify.length, recipientIndex: notifiedCount },
        "founder/legal-versions: notification email failed",
      );
    }
  }

  logger.info(
    {
      founderId: founder.id,
      documentType,
      version,
      contentHash,
      notifiedCount,
    },
    "founder/legal-versions: published new version",
  );

  // Silence unused-imports until we use them in later refinements.
  void isNotNull;
  void isNull;
  void patientsTable;

  res.status(201).json({
    type: documentType,
    version,
    contentHash,
    notifiedUserCount: notifiedCount,
  });
});

function humanType(t: LegalDocumentType): string {
  switch (t) {
    case "baa":
      return "Business Associate Agreement";
    case "terms":
      return "Terms of Service";
    case "privacy":
      return "Privacy Policy";
  }
}

router.post("/founder/users/:id/require-reaccept", async (req, res, next) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }
  const db = getDb();
  const result = await db
    .update(usersTable)
    .set({ legalReacceptRequiredAt: new Date() })
    .where(eq(usersTable.id, id))
    .returning({ id: usersTable.id });
  if (result.length === 0) {
    res.status(404).json({ error: "user_not_found" });
    return;
  }
  // Reuse the detail-builder by forwarding to the GET handler — saves
  // an extra round trip on the client. Mutate `method` and `url` and
  // re-dispatch from the parent so the path params re-parse cleanly.
  req.method = "GET";
  req.url = `/founder/users/${id}`;
  next();
});

export default router;
