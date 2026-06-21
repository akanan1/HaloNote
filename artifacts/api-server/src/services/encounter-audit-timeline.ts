// Encounter-scoped audit timeline. Returns audit_log rows for every
// resource tied to a given encounter:
//
//   - the encounter row itself (status changes, athena link transitions)
//   - the encounter's note(s)
//   - the encounter's coding sessions
//   - the billing_suggestions belonging to those sessions
//   - the problem_list_suggestions for those sessions
//   - the approved_billing_codes for the encounter
//
// Non-admin: regular providers + billers need to see who did what on
// "their" encounter. Org-scoped on every query so cross-tenant rows
// stay invisible.
//
// One round trip via a UNION over the id sets, then a single SELECT
// from audit_log. Reverse-chrono.

import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";

export interface EncounterAuditEvent {
  id: string;
  at: string;
  userId: string | null;
  userDisplayName: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
}

export type EncounterAuditTimelineResult =
  | { kind: "ok"; events: EncounterAuditEvent[] }
  | { kind: "encounter_not_found" };

export async function getEncounterAuditTimeline(args: {
  encounterId: string;
  orgId: string;
  limit?: number;
}): Promise<EncounterAuditTimelineResult> {
  const db = getDb();
  const limit = Math.min(Math.max(args.limit ?? 200, 1), 500);

  // Verify the encounter exists in this org so a 404 is a real 404, not
  // a noisy empty timeline for a typo'd id.
  const encExists = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM encounters
      WHERE id = ${args.encounterId}
        AND organization_id = ${args.orgId}
    ) AS exists
  `);
  if (!encExists.rows[0]?.exists) return { kind: "encounter_not_found" };

  // The id-set UNION: anything that could carry an audit row referring
  // back to this encounter. Cast to text so PG concatenates the union
  // members cleanly even though each source id has the same shape.
  const rows = await db.execute<{
    id: string;
    at: Date;
    user_id: string | null;
    user_display_name: string | null;
    action: string;
    resource_type: string;
    resource_id: string | null;
    metadata: Record<string, unknown> | null;
  }>(sql`
    WITH encounter_resources AS (
      SELECT ${args.encounterId}::text AS resource_id
      UNION
      SELECT n.id FROM notes n
        WHERE n.encounter_id = ${args.encounterId}
          AND n.organization_id = ${args.orgId}
      UNION
      SELECT s.id FROM encounter_coding_sessions s
        WHERE s.encounter_id = ${args.encounterId}
          AND s.organization_id = ${args.orgId}
      UNION
      SELECT bs.id FROM billing_suggestions bs
        WHERE bs.encounter_id = ${args.encounterId}
          AND bs.organization_id = ${args.orgId}
      UNION
      SELECT pls.id FROM problem_list_suggestions pls
        WHERE pls.encounter_id = ${args.encounterId}
          AND pls.organization_id = ${args.orgId}
      UNION
      SELECT abc.id FROM approved_billing_codes abc
        WHERE abc.encounter_id = ${args.encounterId}
          AND abc.organization_id = ${args.orgId}
    )
    SELECT
      al.id,
      al.at,
      al.user_id,
      u.display_name AS user_display_name,
      al.action,
      al.resource_type,
      al.resource_id,
      al.metadata
    FROM audit_log al
    LEFT JOIN users u ON u.id = al.user_id
    WHERE al.organization_id = ${args.orgId}
      AND al.resource_id IN (SELECT resource_id FROM encounter_resources)
    ORDER BY al.at DESC
    LIMIT ${limit}
  `);

  return {
    kind: "ok",
    events: rows.rows.map((r) => ({
      id: r.id,
      at: new Date(r.at).toISOString(),
      userId: r.user_id,
      userDisplayName: r.user_display_name,
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      metadata: r.metadata,
    })),
  };
}
