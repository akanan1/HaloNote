import { Router, type IRouter } from "express";
import { asc, eq } from "drizzle-orm";
import { UpdateUserBody } from "@workspace/api-zod";
import { getDb, usersTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/require-admin";

const router: IRouter = Router();

// Every route in this file is admin-only.
router.use(requireAdmin);

const userSelect = {
  id: usersTable.id,
  email: usersTable.email,
  displayName: usersTable.displayName,
  role: usersTable.role,
  ehrPractitionerId: usersTable.ehrPractitionerId,
  createdAt: usersTable.createdAt,
} as const;

router.get("/users", async (_req, res) => {
  const rows = await getDb()
    .select(userSelect)
    .from(usersTable)
    .orderBy(asc(usersTable.email));
  res.json({ data: rows });
});

router.patch("/users/:id", async (req, res) => {
  const parsed = UpdateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_request",
      issues: parsed.error.issues,
    });
    return;
  }

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
