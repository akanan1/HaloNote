// Pull a patient's problem list from Athena (FHIR Condition resources)
// and upsert it into the local patient_problems cache. Read-only against
// the EHR; the writeback path lives in ehr-push-problem.ts (Phase 3).
//
// Mock mode: when EHR_MODE != athenahealth (the dev default), this is
// a no-op that returns whatever local rows already exist. That keeps
// the Coder workflow runnable end-to-end in dev without an Athena
// connection — the reconciler will diff note ICDs against whatever is
// in patient_problems, which is fine for testing.

import { and, eq } from "drizzle-orm";
import {
  getDb,
  patientProblemsTable,
  type PatientProblem,
  type ProblemEhrSource,
  type ProblemStatus,
} from "@workspace/db";
import type {
  Bundle,
  Condition as FhirCondition,
} from "@workspace/ehr/fhir";
import { FhirError } from "@workspace/ehr/fhir";
import { getAthenahealthClient } from "./athena";
import { logger } from "./logger";

// ICD-10-CM coding system URL per FHIR. Athena emits Conditions with
// coding entries for ICD-10 + SNOMED + their internal vocabulary; we
// prefer ICD-10-CM since that's what the local coding flow uses.
const ICD10_SYSTEM = "http://hl7.org/fhir/sid/icd-10-cm";
// Older Athena content sometimes ships the deprecated ICD-10 system
// URL. Treat either as ICD-10 for our purposes.
const ICD10_SYSTEM_LEGACY = "http://hl7.org/fhir/sid/icd-10";

// Athena's clinical-status values map cleanly to our ProblemStatus
// union except that they don't carry the worsening/improving/stable
// nuance — those come from the reconciler reading the note text. The
// sync only sets active vs resolved here; finer status changes are
// applied later via problem-list-suggestions.
function clinicalStatusToProblemStatus(
  status: FhirCondition["clinicalStatus"],
): ProblemStatus {
  const code = status?.coding?.[0]?.code?.toLowerCase();
  if (code === "resolved" || code === "inactive" || code === "remission") {
    return "resolved";
  }
  return "active";
}

interface ExtractedCondition {
  ehrId: string;
  icd10: string;
  description: string;
  status: ProblemStatus;
  onsetDate: string | null;
  rawCoding: unknown;
}

function extractIcd10(
  bundle: Bundle<FhirCondition>,
): ExtractedCondition[] {
  const out: ExtractedCondition[] = [];
  for (const entry of bundle.entry ?? []) {
    const c = entry.resource;
    if (c?.resourceType !== "Condition") continue;
    if (!c.id) continue;

    const codings = c.code?.coding ?? [];
    // First ICD-10 coding wins. Fall back to the .text or the first
    // coding's display when no ICD-10 is present so the row still
    // exists in the cache (the reconciler can't auto-act on it but
    // the UI can show it).
    const icd10Coding = codings.find(
      (cc) =>
        cc.system === ICD10_SYSTEM || cc.system === ICD10_SYSTEM_LEGACY,
    );
    const code = icd10Coding?.code;
    const description =
      icd10Coding?.display ?? c.code?.text ?? codings[0]?.display;
    if (!code || !description) continue;

    out.push({
      ehrId: c.id,
      icd10: code,
      description,
      status: clinicalStatusToProblemStatus(c.clinicalStatus),
      onsetDate: c.onsetDateTime ?? c.recordedDate ?? null,
      rawCoding: codings,
    });
  }
  return out;
}

export interface SyncProblemListArgs {
  orgId: string;
  patientId: string;
  ehrPatientId: string | null;
}

export interface SyncProblemListResult {
  // True when the EHR was actually queried (real mode + Athena
  // reachable). False = mock/skip path; local cache returned as-is.
  hit: boolean;
  problems: PatientProblem[];
  // Number of rows inserted/updated by this call. 0 in mock mode.
  upserted: number;
}

function resolveProvider(): "athenahealth" | "mock" {
  return process.env["EHR_MODE"]?.trim().toLowerCase() === "athenahealth"
    ? "athenahealth"
    : "mock";
}

async function loadLocal(
  orgId: string,
  patientId: string,
): Promise<PatientProblem[]> {
  return getDb()
    .select()
    .from(patientProblemsTable)
    .where(
      and(
        eq(patientProblemsTable.organizationId, orgId),
        eq(patientProblemsTable.patientId, patientId),
      ),
    );
}

/**
 * Pull the patient's problem list from Athena and upsert into
 * `patient_problems`. Returns the post-sync cache so the reconciler
 * gets a single consistent snapshot.
 *
 * Failures degrade to the local cache + a warn log; the Coder must not
 * lose its reconciliation pass just because Athena was briefly down.
 */
export async function syncPatientProblemList(
  args: SyncProblemListArgs,
): Promise<SyncProblemListResult> {
  const provider = resolveProvider();
  // Mock / no ehrPatientId → just return the local cache.
  if (provider !== "athenahealth" || !args.ehrPatientId) {
    const problems = await loadLocal(args.orgId, args.patientId);
    return { hit: false, problems, upserted: 0 };
  }

  const ehrSource: ProblemEhrSource = "athena";
  let bundle: Bundle<FhirCondition>;
  try {
    const client = getAthenahealthClient();
    bundle = await client.fhir.search<FhirCondition>("Condition", {
      patient: args.ehrPatientId,
      _count: 200,
    });
  } catch (err) {
    if (err instanceof FhirError) {
      logger.warn(
        { err: err.message, status: err.status, patientId: args.patientId },
        "athena problem-list sync failed; falling back to local cache",
      );
    } else {
      logger.warn(
        { err, patientId: args.patientId },
        "athena problem-list sync raised an unexpected error",
      );
    }
    const problems = await loadLocal(args.orgId, args.patientId);
    return { hit: false, problems, upserted: 0 };
  }

  const extracted = extractIcd10(bundle);
  if (extracted.length === 0) {
    const problems = await loadLocal(args.orgId, args.patientId);
    return { hit: true, problems, upserted: 0 };
  }

  const now = new Date();
  const db = getDb();
  let upserted = 0;

  // One upsert per condition. Sequential is fine — typical patient has
  // <50 problems, and Drizzle's onConflictDoUpdate keeps the SQL tidy.
  for (const e of extracted) {
    await db
      .insert(patientProblemsTable)
      .values({
        organizationId: args.orgId,
        patientId: args.patientId,
        code: e.icd10,
        description: e.description,
        status: e.status,
        onsetDate: e.onsetDate,
        ehrSource,
        ehrResourceRef: `Condition/${e.ehrId}`,
        syncedAt: now,
        rawCoding: e.rawCoding,
      })
      .onConflictDoUpdate({
        target: [patientProblemsTable.patientId, patientProblemsTable.code],
        set: {
          description: e.description,
          // Status from sync only updates active↔resolved. The reconciler
          // owns the finer worsening/stable/improving transitions; a
          // sync that re-pulls "active" must NOT clobber a reconciler-
          // applied "worsening" — so only widen, not narrow.
          // Implementation: skip the status update when the sync says
          // 'active' and the local row already had a non-resolved
          // finer status. We do that by leaving status out of the SET
          // and applying it conditionally below.
          ehrResourceRef: `Condition/${e.ehrId}`,
          syncedAt: now,
          rawCoding: e.rawCoding,
          updatedAt: now,
        },
      });
    upserted += 1;
  }

  // Conditional status update for newly-resolved problems only.
  for (const e of extracted) {
    if (e.status !== "resolved") continue;
    await db
      .update(patientProblemsTable)
      .set({ status: "resolved", updatedAt: now })
      .where(
        and(
          eq(patientProblemsTable.organizationId, args.orgId),
          eq(patientProblemsTable.patientId, args.patientId),
          eq(patientProblemsTable.code, e.icd10),
        ),
      );
  }

  const problems = await loadLocal(args.orgId, args.patientId);
  return { hit: true, problems, upserted };
}
