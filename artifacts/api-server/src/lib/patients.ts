import { asc, eq } from "drizzle-orm";
import { getDb, patientsTable, type Patient } from "@workspace/db";
import { logger } from "./logger";

export type { Patient };

// Demo roster seeded into an empty patients table on first boot. Remove
// once real patient onboarding (or a sync from an EHR) is wired up.
const DEMO_PATIENTS: Array<Omit<Patient, "createdAt">> = [
  {
    id: "pt_001",
    firstName: "Marisol",
    lastName: "Aguirre",
    dateOfBirth: "1958-07-22",
    mrn: "MRN-10458",
  },
  {
    id: "pt_002",
    firstName: "Daniel",
    lastName: "Okafor",
    dateOfBirth: "1991-02-14",
    mrn: "MRN-22817",
  },
  {
    id: "pt_003",
    firstName: "Priya",
    lastName: "Bhattacharya",
    dateOfBirth: "1976-11-03",
    mrn: "MRN-33904",
  },
  {
    id: "pt_004",
    firstName: "Wesley",
    lastName: "Tran",
    dateOfBirth: "2002-05-30",
    mrn: "MRN-40771",
  },
];

export async function listPatients(): Promise<Patient[]> {
  return getDb()
    .select()
    .from(patientsTable)
    .orderBy(asc(patientsTable.lastName), asc(patientsTable.firstName));
}

export async function findPatient(id: string): Promise<Patient | null> {
  const rows = await getDb()
    .select()
    .from(patientsTable)
    .where(eq(patientsTable.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function seedPatientsIfEmpty(): Promise<void> {
  const db = getDb();
  const existing = await db.select({ id: patientsTable.id }).from(patientsTable).limit(1);
  if (existing.length > 0) return;

  await db.insert(patientsTable).values(DEMO_PATIENTS);
  logger.info(
    { count: DEMO_PATIENTS.length },
    "Seeded patients table with demo roster",
  );
}
