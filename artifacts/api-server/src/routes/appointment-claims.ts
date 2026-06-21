import { Router, type IRouter } from "express";
import { and, eq, gt } from "drizzle-orm";
import { z } from "@workspace/api-zod";
import {
  appointmentClaimsTable,
  getDb,
  patientsTable,
} from "@workspace/db";
import { getActiveOrgId } from "../lib/active-org";
import { respondInvalidBody } from "../http";

const router: IRouter = Router();

// Server-side equivalent of the prior localStorage cache. See
// lib/db/src/schema/appointment-claims.ts for the table-level rationale.
//
// TTL is enforced server-side via expires_at + a WHERE filter on read;
// no background job sweeps expired rows because the dataset stays small
// (one row per active appointment per provider per org). A future scale
// concern would warrant a cleanup cron.
const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const ClaimBody = z.object({
  appointmentId: z.string().min(1).max(200),
  patientId: z.string().min(1).max(200),
});

interface SerializedClaim {
  appointmentId: string;
  patientId: string;
  claimedAt: string;
  expiresAt: string;
}

function serialize(row: typeof appointmentClaimsTable.$inferSelect): SerializedClaim {
  return {
    appointmentId: row.appointmentId,
    patientId: row.patientId,
    claimedAt: row.claimedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

// Upsert a claim for (org, appointmentId). Last-writer-wins — if a
// different provider clicked into the same appointment, this replaces
// their claim. The patient must belong to the caller's org; we 404 on
// missing-or-cross-tenant.
router.post("/appointment-claims", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const parsed = ClaimBody.safeParse(req.body);
  if (!parsed.success) return respondInvalidBody(res, parsed.error);

  // Patient tenancy check — same 404-not-403 semantics as createNote.
  const [patient] = await getDb()
    .select({
      id: patientsTable.id,
      organizationId: patientsTable.organizationId,
    })
    .from(patientsTable)
    .where(eq(patientsTable.id, parsed.data.patientId))
    .limit(1);
  if (!patient || patient.organizationId !== orgId) {
    res.status(404).json({ error: "patient_not_found" });
    return;
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + CLAIM_TTL_MS);

  // Upsert on the (org, appointment) primary key. Updates userId,
  // patientId, claimedAt, expiresAt — the previous claimant is
  // displaced.
  const [row] = await getDb()
    .insert(appointmentClaimsTable)
    .values({
      organizationId: orgId,
      appointmentId: parsed.data.appointmentId,
      userId: user.id,
      patientId: parsed.data.patientId,
      claimedAt: now,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [
        appointmentClaimsTable.organizationId,
        appointmentClaimsTable.appointmentId,
      ],
      set: {
        userId: user.id,
        patientId: parsed.data.patientId,
        claimedAt: now,
        expiresAt,
      },
    })
    .returning();
  if (!row) throw new Error("Upsert returned no row");
  res.status(201).json(serialize(row));
});

// List the caller's own active (non-expired) claims. The schedule view
// uses this on mount to render per-appointment "claimed by you" badges
// and to thread the right note back to the right schedule row.
router.get("/appointment-claims/mine", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const rows = await getDb()
    .select()
    .from(appointmentClaimsTable)
    .where(
      and(
        eq(appointmentClaimsTable.organizationId, orgId),
        eq(appointmentClaimsTable.userId, user.id),
        gt(appointmentClaimsTable.expiresAt, new Date()),
      ),
    );
  res.json({ data: rows.map(serialize) });
});

// Release a claim. Idempotent — a missing row still returns 204 so the
// client can replay safely on a flaky network. Scoped by user_id so a
// provider can only release their own claims.
router.delete("/appointment-claims/:appointmentId", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  await getDb()
    .delete(appointmentClaimsTable)
    .where(
      and(
        eq(appointmentClaimsTable.organizationId, orgId),
        eq(appointmentClaimsTable.appointmentId, req.params.appointmentId),
        eq(appointmentClaimsTable.userId, user.id),
      ),
    );
  res.status(204).end();
});

export default router;
