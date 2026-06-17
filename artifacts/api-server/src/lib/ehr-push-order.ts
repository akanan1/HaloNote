import { EhrPushError, type EhrPushOutcome } from "./ehr-push";
import { logger } from "./logger";
import type { Patient } from "./patients";

// Order shape the pusher needs. Kept narrow on purpose — the
// approved_orders row carries ~25 columns, most of which aren't
// needed to emit a FHIR resource. Caller maps DB row → this.
export interface PushableOrder {
  id: string;
  orderType:
    | "lab"
    | "imaging"
    | "referral"
    | "medication"
    | "procedure"
    | "followup"
    | "instruction"
    | "dme"
    | "therapy"
    | "nursing";
  name: string;
  indication: string | null;
  indicationDiagnosisCode: string | null;
  priority: "routine" | "urgent" | "stat";
  instructions: string | null;
  frequency: string | null;
  duration: string | null;
  medicationName: string | null;
  medicationDose: string | null;
  medicationRoute: string | null;
  medicationFrequency: string | null;
  medicationDuration: string | null;
  medicationQuantity: number | null;
  medicationRefills: number | null;
}

export interface PushOrderParams {
  order: PushableOrder;
  patient: Patient;
  /** Encounter the order is tied to (FHIR Encounter.id). */
  encounterEhrRef: string | null;
  /** When the author has a SMART connection, push via their per-user
   *  client so the resource carries their identity. */
  userId?: string;
}

function resolveProvider(): "athenahealth" | "epic" | "mock" {
  const mode = process.env["EHR_MODE"]?.trim().toLowerCase();
  if (mode === "athenahealth") return "athenahealth";
  if (mode === "epic") return "epic";
  return "mock";
}

/**
 * Push an approved order to the EHR. Two outcomes:
 *
 *   - mock (default in dev / when EHR_MODE is unset): the call is
 *     logged with structural facts (no medication name, no patient
 *     PHI — handled by logger redaction) and returns a synthetic
 *     ehrDocumentRef so the rest of the pipeline behaves as if a
 *     real push happened.
 *
 *   - real (athenahealth / epic): falls through to NOT YET
 *     IMPLEMENTED. The FHIR R4 resources are MedicationRequest /
 *     ServiceRequest depending on orderType — each vendor's REST
 *     contract for create varies meaningfully, and shipping the
 *     real wire path needs sandbox testing per provider. The mock
 *     mode is sufficient for the rest of the app to exercise the
 *     send-to-ehr / retry / status flows today; real push wiring
 *     is the next sub-phase per provider.
 *
 * Throws EhrPushError on a real-mode failure so the caller can
 * persist the error string + 502 the request.
 */
export async function pushOrderToEhr(
  params: PushOrderParams,
): Promise<EhrPushOutcome> {
  const provider = resolveProvider();

  if (provider === "mock") {
    const syntheticId = `mock-${params.order.id}`;
    // Resource type for the synthetic id reflects what the FHIR push
    // *would* produce so consumers downstream (e.g. retry UX, audit
    // log labels) see the right shape.
    const resourceType =
      params.order.orderType === "medication"
        ? "MedicationRequest"
        : "ServiceRequest";
    logger.info(
      {
        orderId: params.order.id,
        orderType: params.order.orderType,
        priority: params.order.priority,
        patientRef: `Patient/${params.patient.id}`,
        encounterRef: params.encounterEhrRef,
        syntheticId,
      },
      "EHR order push (mock) — EHR_MODE not set to a real provider; not posting upstream",
    );
    return {
      provider: "mock",
      ehrDocumentRef: `${resourceType}/${syntheticId}`,
      pushedAt: new Date(),
      mock: true,
    };
  }

  // Real-mode wiring goes here in a follow-up sub-phase: build the
  // FHIR resource (MedicationRequest / ServiceRequest), POST via
  // the per-user or org-level client, return the created ref. For
  // now we 501 so a misconfigured prod can't silently no-op.
  logger.warn(
    { orderId: params.order.id, provider, userId: params.userId },
    "EHR order push: real-mode wiring not yet implemented for this provider",
  );
  throw new EhrPushError(
    `ehr_order_push_not_implemented_for_${provider}`,
    501,
  );
}
