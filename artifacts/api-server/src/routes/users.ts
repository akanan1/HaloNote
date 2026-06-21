import { Router, type IRouter } from "express";
import { respondInvalidBody } from "../http";
import { and, asc, eq } from "drizzle-orm";
import { UpdateUserBody } from "@workspace/api-zod";
import {
  getDb,
  organizationMembersTable,
  usersTable,
} from "@workspace/db";
import { requireAdmin } from "../middlewares/require-admin";
import { getActiveOrgId } from "../lib/active-org";

const router: IRouter = Router();

// Every route in this file is admin-only. This `router.use` is
// path-agnostic, so the parent MUST mount this sub-router under a path
// prefix ("/users") — otherwise the 403 fires on every request that
// reaches this router and breaks unrelated non-admin routes mounted
// after it.
router.use(requireAdmin);

const userSelect = {
  id: usersTable.id,
  email: usersTable.email,
  displayName: usersTable.displayName,
  role: usersTable.role,
  ehrPractitionerId: usersTable.ehrPractitionerId,
  createdAt: usersTable.createdAt,
} as const;

router.get("/", async (req, res) => {
  // Tenancy: admin is a per-user role, not per-deployment. List only
  // the members of the caller's active org, not every system user. An
  // admin querying this endpoint expects to manage their own clinic;
  // exposing other tenants' user lists would leak email addresses
  // across orgs.
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;

  const rows = await getDb()
    .select(userSelect)
    .from(usersTable)
    .innerJoin(
      organizationMembersTable,
      and(
        eq(organizationMembersTable.userId, usersTable.id),
        eq(organizationMembersTable.organizationId, orgId),
        eq(organizationMembersTable.isActive, true),
      ),
    )
    .orderBy(asc(usersTable.email));
  res.json({ data: rows });
});

router.patch("/:id", async (req, res) => {
  const parsed = UpdateUserBody.safeParse(req.body);
  if (!parsed.success) return respondInvalidBody(res, parsed.error);

  const targetId = req.params.id;
  const caller = req.user;
  if (!caller) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  // Self-demotion: if alice (the only admin) downgrades herself to
  // member, the system has no admin anymore. Refuse. The check is on
  // the SERVER, not just the UI, because a clever member could craft
  // the request directly… well, except requireAdmin already gates the
  // route, so the request can only come from an admin. The case we're
  // guarding is: admin → member on their own id. Anything else is fine.
  if (
    parsed.data.role === "member" &&
    targetId === caller.id &&
    caller.role === "admin"
  ) {
    res.status(403).json({ error: "cannot_demote_self" });
    return;
  }

  // Admins must have TOTP enrolled (see /auth/login enforcement). Refuse
  // to promote a user who hasn't enrolled yet — otherwise we'd create a
  // row that immediately can't log in. The admin's runbook: ask the
  // target to enroll TOTP first (POST /auth/2fa/setup + verify-setup),
  // then re-issue the PATCH.
  if (parsed.data.role === "admin") {
    const [target] = await getDb()
      .select({
        id: usersTable.id,
        totpEnabledAt: usersTable.totpEnabledAt,
      })
      .from(usersTable)
      .where(eq(usersTable.id, targetId))
      .limit(1);
    if (!target) {
      res.status(404).json({ error: "user_not_found" });
      return;
    }
    if (!target.totpEnabledAt) {
      res.status(409).json({
        error: "target_must_enroll_totp_before_admin",
      });
      return;
    }
  }

  // Patch only the fields actually present in the request.
  const updates: {
    role?: "admin" | "member";
    ehrPractitionerId?: string | null;
  } = {};
  if (parsed.data.role !== undefined) updates.role = parsed.data.role;
  if (parsed.data.ehrPractitionerId !== undefined) {
    // Treat empty string the same as null — admin clearing the field.
    updates.ehrPractitionerId =
      parsed.data.ehrPractitionerId === ""
        ? null
        : parsed.data.ehrPractitionerId;
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "no_fields_to_update" });
    return;
  }

  const updated = await getDb()
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, targetId))
    .returning(userSelect);
  const row = updated[0];
  if (!row) {
    res.status(404).json({ error: "user_not_found" });
    return;
  }
  res.json(row);
});

export default router;
