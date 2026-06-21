// Push an accepted problem-list change back to the EHR. Mirrors the
// shape of ehr-push-billing / ehr-push-order. Mock mode (default) is
// a no-op log; real mode routes to the Athena chart REST API via
// athena-chart-api.ts (SANDBOX-VERIFY parameter names before flipping).

import { getAthenaChartClient } from "./athena-chart-api";
import { EhrPushError, type EhrPushOutcome } from "./ehr-push";
import { logger } from "./logger";

export interface PushProblemParams {
  // The local problem_list_suggestions row id; doubles as the
  // idempotency key prefix so retries reuse the same key.
  suggestionId: string;
  action: "add" | "update_status" | "resolve" | "merge_duplicate" | "flag_uncertain";
  // Patient-side ehr id (patients.ehr_patient_id). Null = patient
  // never synced from the EHR; we can't push anywhere meaningful.
  patientEhrId: string | null;
  icd10: string;
  description: string;
  status: "active" | "stable" | "worsening" | "improving" | "resolved";
}

function resolveProvider(): "athenahealth" | "mock" {
  return process.env["EHR_MODE"]?.trim().toLowerCase() === "athenahealth"
    ? "athenahealth"
    : "mock";
}

export async function pushProblemListChangeToEhr(
  params: PushProblemParams,
): Promise<EhrPushOutcome> {
  // Only `add` and `resolve` have a meaningful push surface today.
  // Status-only updates (active → stable) don't exist in Athena's
  // problem-list write API; they're a HaloNote-local concept the
  // clinician uses for tracking. flag_uncertain never pushes by
  // definition. merge_duplicate could be modeled as a PUT but
  // Athena's API for that is practice-specific — punt to a follow-up.
  if (params.action !== "add" && params.action !== "resolve") {
    return {
      provider: "mock",
      ehrDocumentRef: `noop/${params.suggestionId}`,
      pushedAt: new Date(),
      mock: true,
    };
  }

  const provider = resolveProvider();

  if (provider === "mock" || !params.patientEhrId) {
    logger.info(
      {
        suggestionId: params.suggestionId,
        action: params.action,
        icd10: params.icd10,
        reason: !params.patientEhrId ? "no_patient_ehr_id" : "mock_mode",
      },
      "problem-list push (mock) — EHR_MODE not athenahealth, or patient has no ehr_patient_id; not posting upstream",
    );
    return {
      provider: "mock",
      ehrDocumentRef: `Problem/mock-${params.suggestionId}`,
      pushedAt: new Date(),
      mock: true,
    };
  }

  const client = getAthenaChartClient();
  const idempotencyKey = `prb_${params.suggestionId}_${params.action}`;
  try {
    const out = await client.pushProblem({
      patientId: params.patientEhrId,
      icd10: params.icd10,
      description: params.description,
      status: params.status === "resolved" ? "resolved" : "active",
      idempotencyKey,
    });
    return {
      provider: "athenahealth",
      ehrDocumentRef: out.resourceRef,
      pushedAt: new Date(),
      mock: false,
    };
  } catch (err) {
    if (err instanceof EhrPushError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new EhrPushError(`athena_problem_push_failed: ${message}`, 502);
  }
}
