import { Router, type IRouter } from "express";
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import { auditLogTable, getDb, usersTable } from "@workspace/db";

const router: IRouter = Router();

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

const auditSelect = {
  id: auditLogTable.id,
  userId: auditLogTable.userId,
  action: auditLogTable.action,
  resourceType: auditLogTable.resourceType,
  resourceId: auditLogTable.resourceId,
  metadata: auditLogTable.metadata,
  at: auditLogTable.at,
  userDisplayName: usersTable.displayName,
} as const;

type AuditRow = {
  id: string;
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: unknown;
  at: Date;
  userDisplayName: string | null;
};

function serialize(row: AuditRow) {
  return {
    id: row.id,
    userId: row.userId,
    userDisplayName: row.userDisplayName,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    metadata: row.metadata ?? null,
    at: row.at,
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

router.get("/audit-log", async (req, res) => {
  const before = parseIsoDate(req.query["before"]);
  const limit = clampLimit(req.query["limit"]);
  const userIdFilter = readStringParam(req.query["userId"]);
  const resourceTypeFilter = readStringParam(req.query["resourceType"]);
  const actionFilter = readStringParam(req.query["action"]);

  const conditions: SQL[] = [];
  if (before) conditions.push(lt(auditLogTable.at, before));
  if (userIdFilter) conditions.push(eq(auditLogTable.userId, userIdFilter));
  if (resourceTypeFilter) {
    conditions.push(eq(auditLogTable.resourceType, resourceTypeFilter));
  }
  if (actionFilter) conditions.push(eq(auditLogTable.action, actionFilter));

  const where =
    conditions.length === 0
      ? undefined
      : conditions.length === 1
        ? conditions[0]
        : and(...conditions);

  const db = getDb();
  const builder = db
    .select(auditSelect)
    .from(auditLogTable)
    .leftJoin(usersTable, eq(auditLogTable.userId, usersTable.id));

  // Fetch limit+1 to know whether another page exists.
  const rows = where
    ? await builder
        .where(where)
        .orderBy(desc(auditLogTable.at))
        .limit(limit + 1)
    : await builder.orderBy(desc(auditLogTable.at)).limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const tail = page[page.length - 1];
  const nextCursor = hasMore && tail ? tail.at.toISOString() : null;

  res.json({ data: page.map(serialize), nextCursor });
});

export default router;
