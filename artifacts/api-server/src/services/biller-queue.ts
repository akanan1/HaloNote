// Biller queue — "encounters coded by Coder, awaiting biller review".
// Joins session → encounter → patient → approved_billing_codes aggregates
// in a single raw-SQL roundtrip. Filtered to sessions in approved /
// writing / complete (i.e. provider has done their pass; biller is the
// next stop). Most-recently-approved first.

import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";

export interface BillerQueueRow {
  sessionId: string;
  encounterId: string;
  patientId: string;
  patientFirstName: string;
  patientLastName: string;
  patientMrn: string | null;
  encounterScheduledAt: string | null;
  encounterVisitType: string;
  sessionStatus: string;
  approvedAt: string | null;
  totalCodes: number;
  billerApprovedCodes: number;
  exportedCodes: number;
  editedCodes: number;
}

const BILLER_QUEUE_STATUSES = ["approved", "writing", "complete"] as const;

export async function listBillerQueue(
  orgId: string,
  limit = 100,
): Promise<BillerQueueRow[]> {
  const db = getDb();

  // Drizzle's relational query API is limited for the cross-table
  // counts we need; drop to a raw SQL aggregate for clarity. The
  // sub-select counts per session and the outer JOIN brings in
  // patient + encounter columns.
  const rows = await db.execute<{
    session_id: string;
    encounter_id: string;
    patient_id: string;
    first_name: string;
    last_name: string;
    mrn: string | null;
    scheduled_at: Date | null;
    visit_type: string;
    session_status: string;
    approved_at: Date | null;
    total_codes: string;
    biller_approved_codes: string;
    exported_codes: string;
    edited_codes: string;
  }>(sql`
    SELECT
      s.id AS session_id,
      s.encounter_id,
      e.patient_id,
      p.first_name,
      p.last_name,
      p.mrn,
      e.scheduled_at,
      e.visit_type,
      s.status AS session_status,
      s.approved_at,
      COALESCE(c.total_codes, 0) AS total_codes,
      COALESCE(c.biller_approved_codes, 0) AS biller_approved_codes,
      COALESCE(c.exported_codes, 0) AS exported_codes,
      COALESCE(c.edited_codes, 0) AS edited_codes
    FROM encounter_coding_sessions s
    JOIN encounters e ON e.id = s.encounter_id
    JOIN patients p ON p.id = e.patient_id
    LEFT JOIN (
      SELECT
        bs.coding_session_id,
        COUNT(*) FILTER (WHERE abc.id IS NOT NULL) AS total_codes,
        COUNT(*) FILTER (WHERE abc.biller_approved_at IS NOT NULL) AS biller_approved_codes,
        COUNT(*) FILTER (WHERE abc.exported_at IS NOT NULL) AS exported_codes,
        COUNT(*) FILTER (WHERE abc.was_edited_before_approval IS TRUE) AS edited_codes
      FROM billing_suggestions bs
      LEFT JOIN approved_billing_codes abc ON abc.source_suggestion_id = bs.id
      WHERE bs.coding_session_id IS NOT NULL
      GROUP BY bs.coding_session_id
    ) c ON c.coding_session_id = s.id
    WHERE s.organization_id = ${orgId}
      AND s.status = ANY(${BILLER_QUEUE_STATUSES as unknown as string[]})
    ORDER BY COALESCE(s.approved_at, s.created_at) DESC
    LIMIT ${limit}
  `);

  return rows.rows.map((r) => ({
    sessionId: r.session_id,
    encounterId: r.encounter_id,
    patientId: r.patient_id,
    patientFirstName: r.first_name,
    patientLastName: r.last_name,
    patientMrn: r.mrn,
    encounterScheduledAt: r.scheduled_at
      ? new Date(r.scheduled_at).toISOString()
      : null,
    encounterVisitType: r.visit_type,
    sessionStatus: r.session_status,
    approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null,
    totalCodes: Number(r.total_codes),
    billerApprovedCodes: Number(r.biller_approved_codes),
    exportedCodes: Number(r.exported_codes),
    editedCodes: Number(r.edited_codes),
  }));
}
