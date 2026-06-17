import { and, asc, desc, eq, sql } from "drizzle-orm";
import { getDb, notesTable, patientsTable, type Patient } from "@workspace/db";
import { logger } from "./logger";

export type { Patient };

// The default org id installed by migration 0021. Demo seed rows are
// attached here so they show up for users of the seeded org without
// any per-clinic configuration. Multi-tenant deployments seed their
// own patients through the create-org flow.
const DEFAULT_ORG_ID = "org_default";

// Demo roster seeded into an empty patients table on first boot. Remove
// once real patient onboarding (or a sync from an EHR) is wired up.
const DEMO_PATIENTS: Array<Omit<Patient, "createdAt">> = [
  {
    id: "pt_001",
    organizationId: DEFAULT_ORG_ID,
    // Demo seed: the ehrPatientId matches the local id so mock-mode
    // chart-note fetches (Phase 33) resolve against the same key.
    ehrPatientId: "pt_001",
    firstName: "Marisol",
    lastName: "Aguirre",
    dateOfBirth: "1958-07-22",
    mrn: "MRN-10458",
  },
  {
    id: "pt_002",
    organizationId: DEFAULT_ORG_ID,
    ehrPatientId: "pt_002",
    firstName: "Daniel",
    lastName: "Okafor",
    dateOfBirth: "1991-02-14",
    mrn: "MRN-22817",
  },
  {
    id: "pt_003",
    organizationId: DEFAULT_ORG_ID,
    ehrPatientId: "pt_003",
    firstName: "Priya",
    lastName: "Bhattacharya",
    dateOfBirth: "1976-11-03",
    mrn: "MRN-33904",
  },
  {
    id: "pt_004",
    organizationId: DEFAULT_ORG_ID,
    ehrPatientId: "pt_004",
    firstName: "Wesley",
    lastName: "Tran",
    dateOfBirth: "2002-05-30",
    mrn: "MRN-40771",
  },
];

export async function listPatients(organizationId: string): Promise<Patient[]> {
  // Order by most-recently-touched (latest note's createdAt), falling
  // back to the patient's own createdAt for those with no notes. This
  // surfaces the patients a provider is actively working with at the
  // top — the common "who did I see today" workflow.
  //
  // The COALESCE puts patient.createdAt as the secondary key so brand-
  // new patients with no notes still show in a stable order rather
  // than getting buried.
  const lastActivity = sql<Date>`
    coalesce(
      (select max(${notesTable.createdAt}) from ${notesTable}
        where ${notesTable.patientId} = ${patientsTable.id}),
      ${patientsTable.createdAt}
    )
  `;
  return getDb()
    .select()
    .from(patientsTable)
    .where(eq(patientsTable.organizationId, organizationId))
    .orderBy(
      desc(lastActivity),
      asc(patientsTable.lastName),
      asc(patientsTable.firstName),
    );
}

export async function findPatient(
  id: string,
  organizationId: string,
): Promise<Patient | null> {
  const rows = await getDb()
    .select()
    .from(patientsTable)
    .where(
      and(
        eq(patientsTable.id, id),
        eq(patientsTable.organizationId, organizationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function seedPatientsIfEmpty(): Promise<void> {
  const db = getDb();
  const existing = await db.select({ id: patientsTable.id }).from(patientsTable).limit(1);
  if (existing.length > 0) return;

  await db.insert(patientsTable).values(DEMO_PATIENTS);
  logger.info(
    { count: DEMO_PATIENTS.length, orgId: DEFAULT_ORG_ID },
    "Seeded patients table with demo roster",
  );
}
