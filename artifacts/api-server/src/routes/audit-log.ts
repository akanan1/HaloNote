import { Router, type IRouter } from "express";
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import { auditLogTable, getDb, usersTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/require-admin";
import { getActiveOrgId } from "../lib/active-org";
import { clampLimit, parseIsoDate, readStringParam } from "../http";

const router: IRouter = Router();

// Gate every route in this file behind admin. requireAuth has already
// run by the time we get here (mounted from the parent router).
// This `router.use` is path-agnostic, so the parent MUST mount this
// sub-router under a path prefix ("/audit-log") — otherwise the 403
// fires on every request that reaches this router and breaks unrelated
// non-admin routes mounted after it.
router.use(requireAdmin);

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

router.get("/", async (req, res) => {
  // Tenancy: admin is a per-user role, not a per-deployment one. An
  // admin in Org A must not see audit rows from Org B. System-level
  // audit rows (organizationId = NULL) are intentionally excluded —
  // they belong to no tenant and surfacing them here would either
  // leak cross-tenant context or require a separate superadmin view.
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;

  const before = parseIsoDate(req.query["before"]);
  const limit = clampLimit(req.query["limit"]);
  const userIdFilter = readStringParam(req.query["userId"]);
  const resourceTypeFilter = readStringParam(req.query["resourceType"]);
  const actionFilter = readStringParam(req.query["action"]);

  const conditions: SQL[] = [eq(auditLogTable.organizationId, orgId)];
  if (before) conditions.push(lt(auditLogTable.at, before));
  if (userIdFilter) conditions.push(eq(auditLogTable.userId, userIdFilter));
  if (resourceTypeFilter) {
    conditions.push(eq(auditLogTable.resourceType, resourceTypeFilter));
  }
  if (actionFilter) conditions.push(eq(auditLogTable.action, actionFilter));

  const where = conditions.length === 1 ? conditions[0]! : and(...conditions);

  const db = getDb();
  const rows = await db
    .select(auditSelect)
    .from(auditLogTable)
    .leftJoin(usersTable, eq(auditLogTable.userId, usersTable.id))
    .where(where)
    .orderBy(desc(auditLogTable.at))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const tail = page[page.length - 1];
  const nextCursor = hasMore && tail ? tail.at.toISOString() : null;

  res.json({ data: page.map(serialize), nextCursor });
});

export default router;
