import { EhrPushError, type EhrPushOutcome } from "./ehr-push";
import { logger } from "./logger";

// Billing code shape the pusher needs. Caller maps DB row → this.
export interface PushableBillingCode {
  id: string;
  codeSystem: "icd10" | "cpt" | "em" | "modifier";
  code: string;
  description: string;
}

export interface PushBillingParams {
  billingCode: PushableBillingCode;
  /** Encounter the code is tied to (FHIR Encounter.id). */
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
 * Push an approved billing code to the EHR / charge system. Same
 * mock-vs-real split as pushOrderToEhr; real path is per-provider
 * follow-up wiring. In FHIR R4 the code would land as a Claim row
 * line item (or via the vendor's charge entry endpoint when FHIR
 * write isn't available, e.g. Athena's REST charges API).
 */
export async function pushBillingCodeToEhr(
  params: PushBillingParams,
): Promise<EhrPushOutcome> {
  const provider = resolveProvider();

  if (provider === "mock") {
    const syntheticId = `mock-${params.billingCode.id}`;
    logger.info(
      {
        billingCodeId: params.billingCode.id,
        codeSystem: params.billingCode.codeSystem,
        // The code itself isn't PHI but logging it makes audit log
        // joins (encounter → code) much easier in dev.
        code: params.billingCode.code,
        encounterRef: params.encounterEhrRef,
        syntheticId,
      },
      "EHR billing push (mock) — EHR_MODE not set to a real provider; not posting upstream",
    );
    return {
      provider: "mock",
      ehrDocumentRef: `Claim/${syntheticId}`,
      pushedAt: new Date(),
      mock: true,
    };
  }

  logger.warn(
    {
      billingCodeId: params.billingCode.id,
      provider,
      userId: params.userId,
    },
    "EHR billing push: real-mode wiring not yet implemented for this provider",
  );
  throw new EhrPushError(
    `ehr_billing_push_not_implemented_for_${provider}`,
    501,
  );
}
